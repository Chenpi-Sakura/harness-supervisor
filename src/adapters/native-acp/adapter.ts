import path from "node:path";
import { SupervisorError } from "../../errors.js";
import type { HarnessAdapter, HarnessCallbacks, HarnessSpawnSpec, RuntimeCapabilities } from "../../types.js";
import { readJsonFile } from "../../util/fsx.js";
import { resolveNativeAcpLaunch, type NativeAcpLaunch, type NativeAcpRuntime } from "./launch.js";
import { NativeAcpSession } from "./session.js";

export class NativeAcpAdapter implements HarnessAdapter {
  readonly processIdentity = "conservative" as const;
  readonly capabilities: RuntimeCapabilities;
  constructor(readonly name: NativeAcpRuntime, private options: { launch?: NativeAcpLaunch; abortTimeoutMs?: number; onStderr?: (workerId: string, text: string) => void } = {}) {
    this.capabilities = { runtime: name, steer: false, followUp: false, cancel: true, resume: true, pause: false, interactiveInput: true, idleContinue: "L3",
      notes: `${name} through an externally installed @agentclientprotocol ACP adapter. Supports standard permission requests and repeated prompts; restart recovery requires the installed adapter to advertise session/load. No active-turn steering, prompt queueing, client filesystem/terminal delegation or user-question extensions are advertised. Uses native authentication and configuration; requested model/effort must be offered and confirmed by ACP. There is no installation-time or per-task download. Three real turns including process restart/session load and exact file-content recall passed: Codex ACP 2.6.0 with Codex 0.169.0, gpt-6-luna/low; Claude ACP 0.107.0 with Claude Code 2.1.325 and native MiniMax-M3.1-Flash configuration. Other adapter versions still require capability checks.` };
  }
  instanceRef() { try { const launch = this.options.launch ?? resolveNativeAcpLaunch(this.name); return `${this.name}:${launch.file}:${launch.args.join("|")}`; } catch { return this.name; } }
  private start(spec: HarnessSpawnSpec, callbacks: HarnessCallbacks, resumeSessionId?: string) {
    if (spec.provider || spec.tools?.length || spec.extraArgs?.length) throw new SupervisorError("UNSUPPORTED", "Native ACP uses its existing provider/tool configuration and accepts no arbitrary extraArgs");
    const base = this.options.launch ?? resolveNativeAcpLaunch(this.name);
    return NativeAcpSession.start({ runtime: this.name, launch: { ...base, env: { ...base.env, ...spec.env } }, spec, callbacks, resumeSessionId, abortTimeoutMs: this.options.abortTimeoutMs,
      onStderr: text => this.options.onStderr?.(spec.workerId, text) });
  }
  spawn(spec: HarnessSpawnSpec, callbacks: HarnessCallbacks) { return this.start(spec, callbacks); }
  async resume(spec: HarnessSpawnSpec, sessionFile: string, callbacks: HarnessCallbacks) {
    const handle = await readJsonFile<{ runtime?: string; protocol?: string; id?: string; cwd?: string }>(sessionFile);
    const normalized = (cwd: string) => process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
    if (!handle || handle.runtime !== this.name || handle.protocol !== "acp" || typeof handle.id !== "string" || !handle.id || !handle.cwd || normalized(handle.cwd) !== normalized(spec.cwd)) {
      throw new SupervisorError("UNSUPPORTED", "ACP session handle is missing, belongs to another runtime, or has a different cwd; refusing a fake resume");
    }
    return this.start(spec, callbacks, handle.id);
  }
}
