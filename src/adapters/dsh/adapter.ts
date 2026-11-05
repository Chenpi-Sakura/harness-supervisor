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
  resolveDshLaunch,
  resolveDshPermissionMode,
  validateDshExtraArgs,
  type DshLaunch,
  type DshPermissionMode,
} from "./launch.js";
import { DshAcpSession, readDshSessionHandle } from "./session.js";

export interface DshAdapterOptions {
  launch?: DshLaunch;
  permissionMode?: DshPermissionMode;
  requestTimeoutMs?: number;
  abortTimeoutMs?: number;
  onStderr?: (workerId: string, text: string) => void;
  onDiagnostic?: (workerId: string, text: string) => void;
}

const CAPABILITIES: RuntimeCapabilities = {
  runtime: "dsh",
  steer: false,
  followUp: false,
  cancel: true,
  resume: true,
  pause: false,
  interactiveInput: true,
  notes:
    "DeepSeek Harness ACP over ndJSON stdio (`dsh --profile acp`). Verified against the desktop-bundled CLI 0.2.1-rc.5 (agent 0.0.1): initialize advertises ACP v1 plus session close/list/resume, session/new and session/resume work, model and reasoning_effort are selectable config options, session/prompt blocks until the turn and descendants settle, session/cancel returns stopReason=cancelled, and stdin EOF exits the process cleanly. session/resume restores the persisted conversation in a new process and requires the identical absolute cwd; there is no session/load, fork, delete or transcript replay. The shipped acp profile reads DSH_PERMISSION_MODE at boot and defaults to workspace-write with approval ask: file writes inside the workspace or platform temp are allowed without a prompt, while an outside write is denied and can trigger session/request_permission for a one-time danger-full-access escalation (verified). HARNESS_SUPERVISOR_DSH_PERMISSION_MODE selects read-only, workspace-write or danger-full-access; danger-full-access removes the file sandbox and sets approval to never. DSH's permission request carries only a tool call id, not the tool name or input; the adapter answers with the offered allow-once/reject-once option. ACP has no active-turn steer, so steer and follow-up are unsupported; a second prompt is rejected while one is active. No plan, commands, terminal, client filesystem, elicitation, MCP stdio or images. usage_update is context occupancy, not billed token usage. DSH's ACP codec maps native aborted/blocked/error turn endings to end_turn, so HS cannot always distinguish those from a normal completion. cwd is not a filesystem sandbox.",
};

export class DshAdapter implements HarnessAdapter {
  readonly name = "dsh";
  readonly capabilities = CAPABILITIES;
  private readonly options: DshAdapterOptions;
  private launch: DshLaunch | null = null;
  private permissionMode: DshPermissionMode | null = null;

  constructor(options: DshAdapterOptions = {}) {
    this.options = options;
  }

  async spawn(spec: HarnessSpawnSpec, callbacks: HarnessCallbacks): Promise<HarnessSession> {
    validateDshExtraArgs(spec.extraArgs);
    this.validateTools(spec);
    await ensureDir(spec.sessionDir);
    return DshAcpSession.start({
      launch: this.launchFor(spec),
      cwd: spec.cwd,
      sessionDir: spec.sessionDir,
      model: spec.model,
      provider: spec.provider,
      thinking: spec.thinking,
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
    validateDshExtraArgs(spec.extraArgs);
    this.validateTools(spec);
    const resolved = path.resolve(sessionFile);
    let info;
    try {
      info = await stat(resolved);
    } catch {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Cannot resume: the DeepSeek Harness session handle does not exist. Refusing to fake a resume.",
        { sessionFile: resolved },
      );
    }
    if (!info.isFile() || info.size === 0) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Cannot resume: the DeepSeek Harness session handle is empty or not a file.",
        { sessionFile: resolved },
      );
    }
    const raw = await readFile(resolved, "utf8");
    const sessionId = readDshSessionHandle(raw);
    if (!sessionId) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Cannot resume: the DeepSeek Harness session handle does not contain an ACP session id.",
        { sessionFile: resolved },
      );
    }
    await ensureDir(spec.sessionDir);
    return DshAcpSession.start({
      launch: this.launchFor(spec),
      cwd: spec.cwd,
      sessionDir: spec.sessionDir,
      model: spec.model,
      provider: spec.provider,
      thinking: spec.thinking,
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

  private validateTools(spec: HarnessSpawnSpec): void {
    if (spec.tools && spec.tools.length > 0) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "DeepSeek Harness ACP exposes no tool allowlist; tools cannot be restricted per worker.",
        { tools: spec.tools },
      );
    }
  }

  private resolveLaunch(): DshLaunch {
    if (!this.launch) {
      this.launch = this.options.launch ?? resolveDshLaunch();
    }
    return this.launch;
  }

  private resolvePermissionMode(): DshPermissionMode {
    if (!this.permissionMode) {
      this.permissionMode = this.options.permissionMode ?? resolveDshPermissionMode();
    }
    return this.permissionMode;
  }

  /** Per-worker environment (command guard, worker id) never mutates the daemon env. */
  private launchFor(spec: HarnessSpawnSpec): DshLaunch {
    const base = this.resolveLaunch();
    const env = { ...base.env, ...(spec.env ?? {}) };
    // DSH reads this at profile boot; there is no ACP setter for it. Always
    // write the resolved value so the child cannot silently drift from the
    // daemon-level setting.
    env.DSH_PERMISSION_MODE = this.resolvePermissionMode();
    return { ...base, env };
  }
}
