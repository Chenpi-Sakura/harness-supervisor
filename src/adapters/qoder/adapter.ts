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
  qoderConfigRoots,
  qoderEnvPrefix,
  resolveQoderLaunch,
  resolveQoderPermissionMode,
  resolveQoderProtocol,
  sessionIdFromFile,
  validateQoderExtraArgs,
  type QoderLaunch,
  type QoderPermissionMode,
  type QoderProtocol,
  type QoderRuntime,
} from "./launch.js";
import { QoderAcpSession, readQoderAcpSessionHandle } from "./acp-session.js";
import { QoderCliSession } from "./session.js";

export interface QoderAdapterOptions {
  runtime?: QoderRuntime;
  launch?: QoderLaunch;
  protocol?: QoderProtocol;
  permissionMode?: QoderPermissionMode;
  requestTimeoutMs?: number;
  abortTimeoutMs?: number;
  onStderr?: (workerId: string, text: string) => void;
  onDiagnostic?: (workerId: string, text: string) => void;
}

const STREAM_JSON_CAPABILITIES: RuntimeCapabilities = {
  runtime: "qoder",
  steer: true,
  followUp: true,
  cancel: true,
  resume: true,
  pause: false,
  interactiveInput: true,
  idleContinue: "L2",
  notes:
    "Qoder CLI stream-json over stdio (--print --input-format stream-json), selected only by HARNESS_SUPERVISOR_QODER_PROTOCOL=stream-json since ACP became the default in 0.7.0. Steering and follow-ups send priority next/later user messages; the CLI accepts them (the supervisor records run.message_sent) but a real 1.1.76 run did not apply an accepted steer to the running turn, so treat message_sent as 'accepted by the stream, not rejected' rather than 'the model saw it'. Cancellation uses the interrupt control request plus process termination and was validated in a real run (queued follow-up never executed). On 1.1.79 and earlier, permission prompts are surfaced as awaiting_input through the can_use_tool control channel and AskUserQuestion was validated in a real run. Qoder 1.1.82 rejects the legacy --permission-prompt-tool stdio flag with stream-json input; in a real 1.1.82 probe an AskUserQuestion under permission mode default failed inside the CLI instead of producing a control request, so prompt-based interaction is not available on 1.1.82 yet. Use bypass_permissions (default) or dont_ask on 1.1.82. Resume uses --resume <session-id> and verifies the returned session id. Qoder sessions live in the user's Qoder config directory. Permission mode is requested explicitly (default bypass_permissions, override HARNESS_SUPERVISOR_QODER_PERMISSION_MODE) and a runtime-reported mismatch fails startup instead of falling back to auto. There is no sandbox: cwd is not a file-isolation boundary. The 3-Turn idle-continuation E2E was run on the ACP transport, not stream-json; stream-json keeps L2 for that path.",
};

const ACP_CAPABILITIES: RuntimeCapabilities = {
  runtime: "qoder",
  steer: false,
  followUp: false,
  cancel: true,
  resume: true,
  pause: false,
  interactiveInput: true,
  idleContinue: "L3",
  notes:
    "Qoder CLI official ACP transport (qodercli --acp, protocolVersion 1), the default since 0.7.0; set HARNESS_SUPERVISOR_QODER_PROTOCOL=stream-json to use the legacy transport. Verified against real 1.1.82: initialize, session/new, session/load, session/prompt, session/cancel, Write approval through session/request_permission, and AskUserQuestion through elicitation/create when the client advertises elicitation.form. Permission modes map to ACP modes (bypass_permissions->yolo, accept_edits->acceptEdits, dont_ask->dontAsk, default->default, auto->auto); plan has no ACP equivalent and is rejected. Steering and queued follow-ups are not implemented: Qoder advertises promptQueueing in initialize._meta, but HS has not verified what a queued prompt does to run boundaries, so the HS session rejects a second prompt while one is active. Cancellation sends the session/cancel notification and responds to pending permissions/questions. ACP prompt results in 1.1.82 contain all-zero token counters, so Token usage is reported as unknown rather than zero. HS writes its own qoder-acp-session.json handle for resume; the conversation itself stays in Qoder's store. Persistent idle continuation was verified on real 1.1.82 with a 3-Turn session (same worker and session, both earlier codewords recalled without restatement). There is no sandbox: cwd is not a file-isolation boundary.",
};

export class QoderAdapter implements HarnessAdapter {
  readonly name: QoderRuntime;
  readonly capabilities: RuntimeCapabilities;
  private readonly options: QoderAdapterOptions;
  private readonly protocol: QoderProtocol;
  private launch: QoderLaunch | null = null;

  constructor(options: QoderAdapterOptions = {}) {
    this.options = options;
    this.name = options.runtime ?? "qoder";
    this.protocol = options.protocol ?? resolveQoderProtocol(process.env, this.name);
    const capabilities = this.protocol === "acp" ? ACP_CAPABILITIES : STREAM_JSON_CAPABILITIES;
    this.capabilities = { ...capabilities, runtime: this.name, ...(this.name === "qoder-cn" ? {
      notes: "Qoder CN reuses the Qoder protocol adapter with a separate executable and config/session identity. Qoder version-specific real validation below does not imply validation of every CN build. " + capabilities.notes.replaceAll("HARNESS_SUPERVISOR_QODER_", "HARNESS_SUPERVISOR_QODER_CN_").replaceAll("qodercli", "qodercn"),
    } : {}) };
  }

  get processIdentity(): "command-line" | "conservative" {
    // stream-json puts --session-id/--resume <id> in argv; --acp does not.
    return this.protocol === "acp" ? "conservative" : "command-line";
  }

  instanceRef(): string {
    const root = qoderConfigRoots(process.env, this.name)[0] ?? "(none)";
    let file = this.name === "qoder-cn" ? "qodercn" : "qodercli";
    try {
      file = this.resolveLaunch().file;
    } catch {
      // Identity is best effort; a launch error surfaces when a session starts.
    }
    return `${this.name}:${this.protocol}:${file}:${root}`;
  }

  async spawn(spec: HarnessSpawnSpec, callbacks: HarnessCallbacks): Promise<HarnessSession> {
    validateQoderExtraArgs(spec.extraArgs);
    if (this.protocol === "acp") {
      return this.startAcp(spec, callbacks);
    }
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

    const acpSessionId = await readQoderAcpSessionHandle(resolved, this.name);
    if (acpSessionId) {
      if (this.protocol !== "acp") {
        throw new SupervisorError(
          "UNSUPPORTED",
          `This worker was created with the Qoder ACP transport. Set ${qoderEnvPrefix(this.name)}_PROTOCOL=acp to resume it; stream-json cannot load an ACP session.`,
          { sessionFile: resolved },
        );
      }
      return this.startAcp(spec, callbacks, acpSessionId);
    }

    if (this.protocol === "acp") {
      throw new SupervisorError(
        "UNSUPPORTED",
        `This worker was created with the Qoder stream-json transport. Set ${qoderEnvPrefix(this.name)}_PROTOCOL=stream-json to resume it; ACP cannot load a stream-json session.`,
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

  private async startAcp(
    spec: HarnessSpawnSpec,
    callbacks: HarnessCallbacks,
    resumeSessionId?: string,
  ): Promise<HarnessSession> {
    if (spec.provider) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Qoder does not take a separate provider; encode the provider in the model name instead.",
        { provider: spec.provider },
      );
    }
    if (spec.tools) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Qoder ACP does not expose a tool allowlist; omit tools or use the stream-json transport.",
        { tools: spec.tools },
      );
    }
    await ensureDir(spec.sessionDir);
    return QoderAcpSession.start({
      launch: this.launchFor(spec),
      args: ["--acp", ...(spec.extraArgs ?? [])],
      cwd: spec.cwd,
      sessionDir: spec.sessionDir,
      permissionMode: this.resolvePermissionMode(),
      modelId: spec.model,
      thinking: spec.thinking,
      ...(resumeSessionId ? { resumeSessionId } : {}),
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

  private resolveLaunch(): QoderLaunch {
    if (!this.launch) {
      this.launch = this.options.launch ?? resolveQoderLaunch(process.env, this.name);
    }
    return this.launch;
  }

  /** Per-worker environment (command guard, worker id) never mutates the daemon env. */
  private launchFor(spec: HarnessSpawnSpec): QoderLaunch {
    const base = this.resolveLaunch();
    return { ...base, runtime: this.name, env: { ...base.env, ...spec.env } };
  }

  private resolvePermissionMode(): QoderPermissionMode {
    return this.options.permissionMode ?? resolveQoderPermissionMode(process.env, this.name);
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
