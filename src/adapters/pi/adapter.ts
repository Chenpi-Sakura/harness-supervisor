import { stat } from "node:fs/promises";
import path from "node:path";
import { SupervisorError } from "../../errors.js";
import type {
  HarnessAdapter,
  HarnessCallbacks,
  HarnessSession,
  HarnessSpawnSpec,
  RuntimeCapabilities,
} from "../../types.js";
import { ensureDir } from "../../util/fsx.js";
import { resolvePiLaunch, validateExtraArgs, type PiLaunch } from "./launch.js";
import { PiRpcSession } from "./session.js";

export interface PiAdapterOptions {
  launch?: PiLaunch;
  requestTimeoutMs?: number;
  abortTimeoutMs?: number;
  onStderr?: (workerId: string, text: string) => void;
  onDiagnostic?: (workerId: string, text: string) => void;
}

const CAPABILITIES: RuntimeCapabilities = {
  runtime: "pi",
  steer: true,
  followUp: true,
  cancel: true,
  resume: true,
  pause: false,
  interactiveInput: true,
  notes:
    "Native Pi RPC. Steering and follow-ups use Pi queues. Cancellation uses abort. Resume loads a persisted Pi session file; pause is not supported.",
};

export class PiAdapter implements HarnessAdapter {
  readonly name = "pi";
  readonly capabilities = CAPABILITIES;
  private readonly options: PiAdapterOptions;
  private launch: PiLaunch | null = null;

  constructor(options: PiAdapterOptions = {}) {
    this.options = options;
  }

  async spawn(spec: HarnessSpawnSpec, callbacks: HarnessCallbacks): Promise<HarnessSession> {
    validateExtraArgs(spec.extraArgs);
    await ensureDir(spec.sessionDir);
    return PiRpcSession.start({
      launch: this.resolveLaunch(),
      args: this.buildArgs(spec),
      cwd: spec.cwd,
      callbacks,
      onStderr: this.options.onStderr
        ? (text) => this.options.onStderr?.(spec.workerId, text)
        : undefined,
      onDiagnostic: this.options.onDiagnostic
        ? (text) => this.options.onDiagnostic?.(spec.workerId, text)
        : undefined,
      requestTimeoutMs: this.options.requestTimeoutMs,
      abortTimeoutMs: this.options.abortTimeoutMs,
    });
  }

  async resume(
    spec: HarnessSpawnSpec,
    sessionFile: string,
    callbacks: HarnessCallbacks,
  ): Promise<HarnessSession> {
    validateExtraArgs(spec.extraArgs);
    const resolved = path.resolve(sessionFile);
    let info;
    try {
      info = await stat(resolved);
    } catch {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Cannot resume: the Pi session file does not exist. This worker either disabled sessions or produced no persisted session.",
        { sessionFile: resolved },
      );
    }
    if (!info.isFile() || info.size === 0) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Cannot resume: the Pi session file is empty or not a file.",
        { sessionFile: resolved },
      );
    }
    await ensureDir(spec.sessionDir);
    return PiRpcSession.start({
      launch: this.resolveLaunch(),
      args: this.buildArgs(spec, resolved),
      cwd: spec.cwd,
      callbacks,
      onStderr: this.options.onStderr
        ? (text) => this.options.onStderr?.(spec.workerId, text)
        : undefined,
      onDiagnostic: this.options.onDiagnostic
        ? (text) => this.options.onDiagnostic?.(spec.workerId, text)
        : undefined,
      requestTimeoutMs: this.options.requestTimeoutMs,
      abortTimeoutMs: this.options.abortTimeoutMs,
    });
  }

  private resolveLaunch(): PiLaunch {
    if (!this.launch) {
      this.launch = this.options.launch ?? resolvePiLaunch();
    }
    return this.launch;
  }

  private buildArgs(spec: HarnessSpawnSpec, sessionFile?: string): string[] {
    const args = [
      "--mode",
      "rpc",
      "--session-dir",
      spec.sessionDir,
      "--name",
      spec.workerId,
    ];
    if (spec.provider) args.push("--provider", spec.provider);
    if (spec.model) args.push("--model", spec.model);
    if (spec.thinking) args.push("--thinking", spec.thinking);
    if (spec.tools && spec.tools.length > 0) args.push("--tools", spec.tools.join(","));
    if (spec.extraArgs) args.push(...spec.extraArgs);
    if (sessionFile) args.push("--session", sessionFile);
    return args;
  }
}
