const pending = new Set(["draining", "switching", "verifying"]);
const stopped = new Set(["cancelled", "failed", "recovery_required", "rolled_back"]);
const versionParts = value => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  ? value.split(".").map(BigInt) : null;

/** Register only; the existing daemon owns draining, backups and handoff. */
export async function syncPairedCore({ external, candidate, request, isCurrent, intentId }) {
  if (external || !isCurrent()) return { state: "external-or-disposed" };
  const info = await request("info");
  if (!isCurrent()) return { state: "disposed" };
  const from = versionParts(info.version), to = versionParts(candidate.version);
  if (!from || !to) return { state: "manual", message: "核心版本无法安全比较，请查看诊断详情。" };
  const order = to.findIndex((part, index) => part !== from[index]);
  if (order < 0 || to[order] < from[order]) return { state: "current", version: info.version };
  if (!["managedRuntime", "drain"].every(key => info.capabilities?.[key] === true)) return { state: "manual", message: "运行核心不支持受控升级，需要维护窗口。" };
  const status = await request("runtime_update_status");
  if (!isCurrent()) return { state: "disposed" };
  if (!status.managed || !status.activeRuntimeId) return { state: "manual", message: "当前核心尚未托管，不自动迁移。" };
  if (pending.has(status.intent?.phase) || stopped.has(status.intent?.phase)) {
    if (status.intent.targetRuntimeId === candidate.id) return { state: status.intent.phase, intentId: status.intent.id };
    if (pending.has(status.intent.phase) || status.intent.phase === "recovery_required") return { state: "conflict", message: "已有其他核心更新或待恢复状态，不覆盖。" };
  }
  // A source change while preparing/checking must not update the former instance.
  if (!isCurrent()) return { state: "disposed" };
  try {
    const intent = await request("runtime_update", { runtimeId: candidate.id, intentId });
    return { state: intent.phase, intentId: intent.id };
  } catch (error) {
    // Never retry an uncertain mutation. The daemon retains the durable intent.
    return { state: error?.code === "CONFLICT" ? "conflict" : "unconfirmed", message: error.message };
  }
}
