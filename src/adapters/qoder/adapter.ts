import { randomUUID } from "node:crypto";
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
import {
  resolveQoderLaunch,
  resolveQoderPermissionMode,
  sessionIdFromFile,
  validateQoderExtraArgs,
  type QoderLaunch,
  type QoderPermissionMode,
} from "./launch.js";
import { QoderCliSession } from "./session.js";

export interface QoderAdapterOptions {
  launch?: QoderLaunch;
  permissionMode?: QoderPermissionMode;
  requestTimeoutMs?: number;
  abortTimeoutMs?: number;
  onStderr?: (workerId: string, text: string) => void;
  onDiagnostic?: (workerId: string, text: string) => void;
}

const CAPABILITIES: RuntimeCapabilities = {
  runtime: "qoder",
  steer: true,
  followUp: true,
  cancel: true,
  resume: true,
  pause: false,
  interactiveInput: true,
  notes:
    "Qoder CLI stream-json over stdio (--print --input-format stream-json). Steering and follow-ups send priority next/later user messages; the CLI accepts them (the supervisor records run.message_sent) but a real 1.1.76 run did not apply an accepted steer to the running turn, so treat message_sent as 'accepted by the stream, not rejected' rather than 'the model saw it'. Cancellation uses the interrupt control request plus process termination and was validated in a real run (queued follow-up never executed). On 1.1.79 and earlier, permission prompts are surfaced as awaiting_input through the can_use_tool control channel and AskUserQuestion was validated in a real run. Qoder 1.1.82 rejects the legacy --permission-prompt-tool stdio flag with stream-json input; in a real 1.1.82 probe an AskUserQuestion under permission mode default failed inside the CLI instead of producing a control request, so prompt-based interaction is not available on 1.1.82 yet. Use bypass_permissions (default) or dont_ask on 1.1.82. Resume uses --resume <session-id> and verifies the returned session id. Qoder sessions live in the user's Qoder config directory. Permission mode is requested explicitly (default bypass_permissions, override HARNESS_SUPERVISOR_QODER_PERMISSION_MODE) and a runtime-reported mismatch fails startup instead of falling back to auto. There is no sandbox: cwd is not a file-isolation boundary.",
};

export class QoderAdapter implements HarnessAdapter {
  readonly name = "qoder";
  readonly capabilities = CAPABILITIES;
  private readonly options: QoderAdapterOptions;
  private launch: QoderLaunch | null = null;

  constructor(options: QoderAdapterOptions = {}) {
    this.options = options;
  }

  async spawn(spec: HarnessSpawnSpec, callbacks: HarnessCallbacks): Promise<HarnessSession> {
    validateQoderExtraArgs(spec.extraArgs);
    await ensureDir(spec.sessionDir);
    const sessionId = randomUUID();
    const permissionMode = this.resolvePermissionMode();
    return QoderCliSession.start({
      launch: this.launchFor(spec),
      args: this.buildArgs(spec, sessionId, false, permissionMode),
      cwd: spec.cwd,
      callbacks,
      sessionId,
      permissionMode,
      modelId: spec.model,
      initialPrompt: spec.initialPrompt,
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
    validateQoderExtraArgs(spec.extraArgs);
    const resolved = path.resolve(sessionFile);
    let info;
    try {
      info = await stat(resolved);
    } catch {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Cannot resume: the Qoder session file does not exist. Refusing to fake a resume.",
        { sessionFile: resolved },
      );
    }
    if (!info.isFile() || info.size === 0) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Cannot resume: the Qoder session file is empty or not a file.",
        { sessionFile: resolved },
      );
    }
    const resumeId = sessionIdFromFile(resolved);
    if (!resumeId) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Cannot resume: the Qoder session file name does not contain a session id.",
        { sessionFile: resolved },
      );
    }
    await ensureDir(spec.sessionDir);
    const permissionMode = this.resolvePermissionMode();
    return QoderCliSession.start({
      launch: this.launchFor(spec),
      args: this.buildArgs(spec, resumeId, true, permissionMode),
      cwd: spec.cwd,
      callbacks,
      sessionId: resumeId,
      resumeId,
      permissionMode,
      requestedSessionFile: resolved,
      modelId: spec.model,
      initialPrompt: spec.initialPrompt,
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

  private resolveLaunch(): QoderLaunch {
    if (!this.launch) {
      this.launch = this.options.launch ?? resolveQoderLaunch();
    }
    return this.launch;
  }

  /** Per-worker environment (command guard, worker id) never mutates the daemon env. */
  private launchFor(spec: HarnessSpawnSpec): QoderLaunch {
    const base = this.resolveLaunch();
    return spec.env ? { ...base, env: { ...base.env, ...spec.env } } : base;
  }

  private resolvePermissionMode(): QoderPermissionMode {
    return this.options.permissionMode ?? resolveQoderPermissionMode(process.env);
  }

  private buildArgs(
    spec: HarnessSpawnSpec,
    sessionId: string,
    resume = false,
    permissionMode = this.resolvePermissionMode(),
  ): string[] {
    if (spec.provider) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Qoder CLI does not take a separate provider; encode the provider in the model name instead.",
        { provider: spec.provider },
      );
    }
    // Qoder CLI 1.1.82 rejects the legacy --permission-prompt-tool stdio
    // combination with stream-json input. Stream-json already installs the
    // stdio control channel on 1.1.79 and earlier, so the flag is redundant.
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--permission-mode",
      permissionMode,
    ];
    if (resume) args.push("--resume", sessionId);
    else args.push("--session-id", sessionId);
    if (spec.model) args.push("--model", spec.model);
    if (spec.thinking) args.push("--thinking", spec.thinking);
    if (spec.tools) {
      args.push("--tools", spec.tools.length > 0 ? spec.tools.join(",") : "");
    }
    if (spec.extraArgs) args.push(...spec.extraArgs);
    return args;
  }
}
