import { readFile, stat } from "node:fs/promises";
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
  resolveMcodeLaunch,
  resolveMcodePermissionMode,
  validateMcodeExtraArgs,
  type McodeLaunch,
  type McodePermissionMode,
} from "./launch.js";
import { McodeAcpSession } from "./session.js";

export interface McodeAdapterOptions {
  launch?: McodeLaunch;
  permissionMode?: McodePermissionMode;
  requestTimeoutMs?: number;
  abortTimeoutMs?: number;
  onStderr?: (workerId: string, text: string) => void;
  onDiagnostic?: (workerId: string, text: string) => void;
}

const CAPABILITIES: RuntimeCapabilities = {
  runtime: "mcode",
  steer: true,
  followUp: true,
  cancel: true,
  resume: true,
  pause: false,
  interactiveInput: true,
  notes:
    "MiniMax Code Agent Client Protocol (ACP) over ndJSON stdio (`mcode acp`). The protocol version was verified against a real 0.6.12 process: initialize, session/new, session/prompt, session/cancel and session/load all answered on the wire, and agent_message_chunk updates arrived during a live turn. session/prompt blocks until the turn ends and the agent rejects a second concurrent prompt. Steering goes through the mcode/session/steer extension and queued follow-ups through mcode/session/queue/enqueue; both require a build that advertises those extensions and are otherwise reported as unsupported. Against a real 0.6.12 process both were confirmed: a steer sent during an active turn was accepted with mode 'steered' and the agent acted on it, and queue/enqueue returned a queued receipt. Steering outside an active turn is rejected by the agent ('Steering requires an admitted, active ACP prompt Turn'), so a steer sent after the turn ended is not delivered. Permission requests arrive as client-side session/request_permission calls and are surfaced as awaiting_input; the reply must reuse the request id and one of the offered option ids. MiniMax Code itself defaults to bypassPermissions, so the worker asks the session to use the Ask mode unless HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE says otherwise. There is no sandbox: cwd is not a file-isolation boundary.",
};

export class McodeAdapter implements HarnessAdapter {
  readonly name = "mcode";
  readonly capabilities = CAPABILITIES;
  private readonly options: McodeAdapterOptions;
  private launch: McodeLaunch | null = null;

  constructor(options: McodeAdapterOptions = {}) {
    this.options = options;
  }

  async spawn(spec: HarnessSpawnSpec, callbacks: HarnessCallbacks): Promise<HarnessSession> {
    validateMcodeExtraArgs(spec.extraArgs);
    await ensureDir(spec.sessionDir);
    return McodeAcpSession.start({
      launch: this.resolveLaunch(),
      args: this.buildArgs(spec),
      cwd: spec.cwd,
      sessionDir: spec.sessionDir,
      permissionMode: this.resolvePermissionMode(),
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
    validateMcodeExtraArgs(spec.extraArgs);
    const resolved = path.resolve(sessionFile);
    let info;
    try {
      info = await stat(resolved);
    } catch {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Cannot resume: the MiniMax Code session handle does not exist. Refusing to fake a resume.",
        { sessionFile: resolved },
      );
    }
    if (!info.isFile() || info.size === 0) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Cannot resume: the MiniMax Code session handle is empty or not a file.",
        { sessionFile: resolved },
      );
    }
    const sessionId = await readMcodeSessionHandle(resolved);
    if (!sessionId) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Cannot resume: the MiniMax Code session handle does not contain a session id.",
        { sessionFile: resolved },
      );
    }
    await ensureDir(spec.sessionDir);
    return McodeAcpSession.start({
      launch: this.resolveLaunch(),
      args: this.buildArgs(spec),
      cwd: spec.cwd,
      sessionDir: spec.sessionDir,
      permissionMode: this.resolvePermissionMode(),
      callbacks,
      resumeSessionId: sessionId,
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

  private resolveLaunch(): McodeLaunch {
    if (!this.launch) {
      this.launch = this.options.launch ?? resolveMcodeLaunch();
    }
    return this.launch;
  }

  private resolvePermissionMode(): McodePermissionMode {
    return this.options.permissionMode ?? resolveMcodePermissionMode();
  }

  private buildArgs(spec: HarnessSpawnSpec): string[] {
    if (spec.provider) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "MiniMax Code does not take a separate provider; encode the provider in the model name instead.",
        { provider: spec.provider },
      );
    }
    // ACP takes its model and session settings from the runtime configuration,
    // not from per-invocation CLI flags.
    return [];
  }
}

/**
 * Reads the ACP session id out of a session handle written by this adapter.
 * The first line must carry `{ "type": "session", "id": ... }`, which is the
 * same shape the supervisor already understands when it has to recover a
 * session id from a persisted file.
 */
export async function readMcodeSessionHandle(handleFile: string): Promise<string | null> {
  try {
    const raw = await readFile(handleFile, "utf8");
    const firstLine = raw.split("\n", 1)[0];
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
    if (parsed.type !== "session") return null;
    return typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : null;
  } catch {
    return null;
  }
}
