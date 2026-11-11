import assert from "node:assert/strict";
import test from "node:test";
import { buildTimelineEntries, eventDataJson, eventSearchText, presentEvent, presentTimelineEntry, timelineEntrySearchText } from "../src/event-presentation.ts";

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

const fragment = (seq, preview, extra = {}) => ({ ...event("run.progress", { kind: "thinking", preview, ...extra }), seq });

test("known ACP thinking deltas merge verbatim, remain fully searchable and retain every raw event", () => {
  const source = [fragment(1, "We"), fragment(2, " "), fragment(3, "should\n  inspect "), fragment(4, "好".repeat(250) + " FullTextMarker")];
  const before = structuredClone(source);
  for (const runtime of ["qoder", "mcode", "dsh"]) {
    const entries = buildTimelineEntries(source, runtime);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].recordedText, "We should\n  inspect " + "好".repeat(250) + " FullTextMarker");
    assert.equal(entries[0].events.length, 4);
    assert.equal(presentTimelineEntry(entries[0]).summary.length, 180);
    assert.ok(timelineEntrySearchText(entries[0]).includes("fulltextmarker"));
    assert.ok(timelineEntrySearchText(entries[0]).includes("we should"));
    assert.strictEqual(entries[0].events[2], source[2]);
  }
  assert.deepEqual(source, before, "aggregation never changes source data");
});

test("tools, lifecycle, turn boundaries, other kinds and sequence gaps stop thinking aggregation", () => {
  for (const boundary of [
    event("run.progress", { kind: "tool_start", tool: "read" }),
    event("run.progress", { kind: "turn_complete" }),
    event("run.progress", { kind: "assistant_message", preview: "commentary" }),
    event("run.completed"), event("worker.resumed"),
  ]) {
    const entries = buildTimelineEntries([fragment(1, "before"), { ...boundary, seq: 2 }, fragment(3, "after")], "qoder");
    assert.equal(entries.length, 3);
  }
  assert.equal(buildTimelineEntries([fragment(1, "first"), fragment(3, "gap")], "mcode").length, 2);
});

test("snapshots, unknown shapes/runtimes and already-truncated records are not blindly concatenated", () => {
  for (const runtime of [undefined, "pi", "future-runtime"]) {
    assert.equal(buildTimelineEntries([fragment(1, "a"), fragment(2, "ab")], runtime).length, 2);
  }
  for (const extra of [{ mode: "snapshot" }, { delta: false }, { messageId: "different" }, { previewTruncated: true }, { detail: "alternate payload" }]) {
    const entries = buildTimelineEntries([fragment(1, "a"), fragment(2, "ab", extra), fragment(3, "c")], "dsh");
    assert.equal(entries.length, 3);
  }
  const snapshots = [1, 2].map(seq => ({ ...event("run.progress", { kind: "assistant_message", preview: "whole snapshot" }), seq }));
  assert.equal(buildTimelineEntries(snapshots, "qoder").length, 2);
  const detailOnly = [1, 2].map(seq => ({ ...event("run.progress", { kind: "thinking", detail: "legacy text" }), seq }));
  assert.equal(buildTimelineEntries(detailOnly, "qoder").length, 2);
  assert.equal(buildTimelineEntries(detailOnly, "qoder")[0].recordedText, "legacy text");
});
