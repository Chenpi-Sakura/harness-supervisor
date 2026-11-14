import { groupOutputEvents } from "../../src/output-groups.js";

export interface TimelineEvent {
  seq: number;
  ts: string;
  type: string;
  data?: Record<string, unknown>;
}

export type EventCategory = "task" | "tool" | "output" | "input" | "system" | "error";

export interface EventPresentation {
  category: EventCategory;
  label: string;
  summary: string;
  failed: boolean;
}

export interface TimelineEntry {
  events: TimelineEvent[];
  recordedText?: string;
}

const SUMMARY_LIMIT = 180;

function text(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function compact(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= SUMMARY_LIMIT) return line;
  const characters = Array.from(line);
  return characters.length > SUMMARY_LIMIT ? `${characters.slice(0, SUMMARY_LIMIT - 1).join("")}…` : line;
}

function recordedOutput(event: TimelineEvent): string | undefined {
  if (event.type !== "run.progress" || !["thinking", "assistant_message"].includes(String(event.data?.kind))) return undefined;
  // Never trim a delta: its leading/trailing whitespace joins adjacent words.
  if (typeof event.data?.preview === "string") return event.data.preview;
  if (typeof event.data?.detail === "string") return event.data.detail;
  return undefined;
}

/** Presentation only: source events, sequence numbers and cursors stay intact. */
export function buildTimelineEntries(events: TimelineEvent[], runtime?: string): TimelineEntry[] {
  return groupOutputEvents(events, runtime).map(group => ({
    events: group,
    recordedText: recordedOutput(group[0]!) === undefined ? undefined : group.map(event => recordedOutput(event) ?? "").join(""),
  }));
}

export function presentTimelineEntry(entry: TimelineEntry): EventPresentation {
  const presentation = presentEvent(entry.events[0]!);
  return entry.recordedText === undefined ? presentation : { ...presentation, summary: compact(entry.recordedText) || "已记录" };
}

export function timelineEntrySearchText(entry: TimelineEntry): string {
  return `${entry.recordedText ?? ""} ${entry.events.map(event => eventSearchText(event, presentEvent(event), eventDataJson(event))).join(" ")}`.toLocaleLowerCase();
}

function joined(...parts: string[]): string {
  return compact([...new Set(parts.filter(Boolean))].join(" · "));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function presentEvent(event: TimelineEvent): EventPresentation {
  const data = event.data ?? {};
  const kind = text(data, "kind");
  const result = (category: EventCategory, label: string, summary: string, failed = false): EventPresentation => ({ category, label, summary: compact(summary), failed });
  const message = text(data, "message", "reason", "error", "detail", "preview", "text");
  if (event.type === "run.progress") {
    if (kind === "tool_start" || kind === "tool_end") {
      const failed = kind === "tool_end" && data.isError === true;
      const duration = finiteNumber(data.durationMs) ? `${data.durationMs} ms` : "";
      return result("tool", kind === "tool_start" ? "调用工具" : failed ? "工具失败" : "工具结束",
        joined(text(data, "tool") || "工具", text(data, "detail"), duration), failed);
    }
    if (kind === "assistant_message" || kind === "thinking") {
      return result("output", kind === "thinking" ? "思考" : "模型输出", text(data, "preview", "detail") || "已记录");
    }
    if (["permission_withdrawn", "input_withdrawn", "elicitation_withdrawn", "input_timeout", "permission_timeout"].includes(kind)) {
      const expired = kind.endsWith("timeout");
      return result("input", expired ? "请求超时" : "请求撤回", message || (expired ? "本次输入请求已过期" : "原生运行时已撤回请求"));
    }
    const progressLabels: Record<string, string> = {
      session_init: "会话初始化", agent_restart: "继续运行", turn_complete: "轮次结束",
      plan: "计划更新", mode_update: "模式更新", retry: "重试", retry_failed: "重试失败",
      compaction: "上下文整理", compaction_start: "开始整理上下文", compaction_end: "上下文整理结束",
      context_usage: "上下文用量", usage: "用量信息", notification: "运行通知",
      steer_accepted: "引导已接收", followup_queued: "后续消息已入队",
      assistant_aborted: "输出已中断",
    };
    const failed = data.isError === true;
    return result(failed ? "error" : "system", progressLabels[kind] || "运行进度", message || kind || event.type, failed);
  }
  switch (event.type) {
    case "worker.starting": return result("task", "准备启动", joined(text(data, "runtime"), text(data, "cwd")) || "正在准备原生 Worker");
    case "worker.started": return result("task", "进程已启动", joined(text(data, "runtime"), finiteNumber(data.pid) ? `PID ${data.pid}` : ""));
    case "run.accepted": return result("task", "任务已接收", data.continued === true ? "已接收续接任务" : data.resumed === true ? "已接收恢复任务" : "等待原生运行时执行");
    case "run.started": return result("task", "开始执行", data.resumed === true ? "在已有会话上执行" : "原生运行时已开始执行");
    case "worker.continued": return result("task", "会话续接", "继续同一个 Worker 会话");
    case "worker.resumed": return result("task", "会话恢复", "已恢复原生会话");
    case "worker.session": return result("system", "会话记录", text(data, "sessionFile", "sessionId") || "原生会话信息已更新");
    case "run.completed": return result("task", "任务完成", joined(data.truncated === true ? "文本已截断" : "", text(data, "text")) || "原生运行时已报告完成");
    case "run.cancelled": return result("task", "任务已取消", text(data, "reason", "error", "partialText") || "当前任务已取消");
    case "worker.cancel_requested": return result("task", "请求取消", message || "正在请求停止执行");
    case "run.failed": return result("error", "任务失败", message || "任务未完成", true);
    case "run.error": return result("error", "运行报错", message || "原生运行时报告错误", true);
    case "worker.crashed": return result("error", "进程异常", message || "原生进程异常退出", true);
    case "worker.resume_failed": return result("error", "恢复失败", message || "无法恢复原生会话", true);
    case "worker.interrupted": return result("task", "执行已中断", message || "任务被中断");
    case "worker.orphaned": return result("error", "失去进程控制", message || "需要核对原生进程状态", true);
    case "worker.exited": return result("system", "进程退出", joined(typeof data.code === "number" && Number.isFinite(data.code) ? `退出码 ${data.code}` : "", text(data, "signal")) || "原生进程已退出");
    case "run.needs_input": return result("input", "等待输入", joined(text(data, "title"), text(data, "message")) || text(data, "method") || "原生运行时需要答复");
    case "run.input_answered": return result("input", "请求已回答", data.cancelled === true ? "已取消本次输入" : "已向原生运行时提交答复");
    case "run.message_sent": return result("input", data.mode === "follow-up" ? "后续消息" : "执行中消息", text(data, "preview") || "消息已发送至原生运行时");
    case "run.usage": {
      const parts: string[] = [];
      for (const [field, label] of [["inputTokens", "输入"], ["outputTokens", "输出"], ["cacheReadTokens", "缓存读取"]]) {
        if (finiteNumber(data[field])) parts.push(`${label} ${data[field]}`);
      }
      return result("system", "用量记录", joined(text(data, "modelId"), ...parts) || "已收到运行时用量记录");
    }
    case "worker.admin": return result("system", "管理操作", message || "Worker 管理状态已更新");
    default: return result("system", "事件", message || event.type);
  }
}

export function eventDataJson(event: TimelineEvent): string {
  try { return JSON.stringify(event.data ?? {}, null, 2); }
  catch { return "无法序列化此事件的数据"; }
}

export function eventSearchText(event: TimelineEvent, presentation: EventPresentation, dataJson: string): string {
  return `${event.seq} ${event.type} ${presentation.label} ${presentation.summary} ${dataJson}`.toLocaleLowerCase();
}
