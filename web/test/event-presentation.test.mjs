import assert from "node:assert/strict";
import test from "node:test";
import { eventDataJson, eventSearchText, presentEvent } from "../src/event-presentation.ts";

const event = (type, data = {}) => ({ seq: 42, ts: "2026-11-11T00:00:00Z", type, data });

test("native tool failures remain tool events rather than task failure claims", () => {
  const started = presentEvent(event("run.progress", { kind: "tool_start", tool: "read", detail: "project.txt" }));
  assert.equal(started.category, "tool");
  assert.equal(started.label, "调用工具");
  assert.equal(started.summary, "read · project.txt");
  const failed = presentEvent(event("run.progress", { kind: "tool_end", tool: "bash", isError: true, durationMs: 0 }));
  assert.equal(failed.category, "tool");
  assert.equal(failed.label, "工具失败");
  assert.equal(failed.failed, true);
  assert.equal(failed.summary, "bash · 0 ms");
  assert.equal(presentEvent(event("run.error", { message: "recoverable", fatal: false })).label, "运行报错");
  assert.equal(presentEvent(event("worker.exited", { code: 0 })).label, "进程退出");
  assert.equal(presentEvent(event("worker.exited", { code: -1 })).summary, "退出码 -1");
});

test("native output and lifecycle summaries stay short without rewriting raw data", () => {
  const input = event("run.progress", { kind: "assistant_message", preview: "line 1\nline 2 " + "好".repeat(300) });
  const display = presentEvent(input);
  assert.equal(display.category, "output");
  assert.equal(display.summary.length, 180);
  assert.ok(display.summary.endsWith("…"));
  assert.ok(!display.summary.includes("\n"));
  assert.ok(eventDataJson(input).includes("好".repeat(300)));
  const emoji = presentEvent(event("run.progress", { kind: "assistant_message", preview: "🚀".repeat(300) }));
  assert.equal(Array.from(emoji.summary).length, 180);
  assert.ok(!emoji.summary.includes("�"));
  assert.ok(presentEvent(event("run.completed", { text: "DONE", truncated: true })).summary.includes("文本已截断"));
  assert.equal(presentEvent(event("run.cancelled", { reason: "user_cancel" })).label, "任务已取消");
  assert.equal(presentEvent(event("run.needs_input", { title: "Approve", message: "Read file?" })).summary, "Approve · Read file?");
  assert.equal(presentEvent(event("run.input_answered", { outcome: "confirmed" })).summary, "已向原生运行时提交答复");
});

test("unknown nested payloads remain searchable and never become object-object summaries", () => {
  const input = event("vendor.event", { title: { nested: "not a title" }, payload: { hidden: "NestedSearchMarker" } });
  const display = presentEvent(input);
  assert.equal(display.summary, "vendor.event");
  assert.ok(eventSearchText(input, display, eventDataJson(input)).includes("nestedsearchmarker"));
  assert.equal(presentEvent(event("run.progress", { kind: "new_kind", detail: {} })).summary, "new_kind");
  assert.doesNotThrow(() => eventDataJson(event("vendor.event", { number: 1n })));
});

test("usage summaries distinguish unreported values from reported zero", () => {
  assert.equal(presentEvent(event("run.usage", { outputTokens: 0 })).summary, "输出 0");
  assert.equal(presentEvent(event("run.usage", {})).summary, "已收到运行时用量记录");
  assert.equal(presentEvent(event("run.usage", { inputTokens: "99", outputTokens: Infinity })).summary, "已收到运行时用量记录");
});
