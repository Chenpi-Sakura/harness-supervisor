import React, { useMemo, useState } from "react";
import { buildTimelineEntries, eventDataJson, presentTimelineEntry, timelineEntrySearchText, type EventCategory, type TimelineEntry } from "./event-presentation";
import { eventHistoryStatus, type EventHistory } from "./event-pages";

export type { TimelineEvent } from "./event-presentation";

const CATEGORY_NAMES: Record<EventCategory, string> = {
  task: "任务", tool: "工具", output: "模型", input: "交互", system: "系统", error: "异常",
};

function eventTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const [open, setOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const first = entry.events[0]!;
  const last = entry.events.at(-1)!;
  const presentation = presentTimelineEntry(entry);
  const merged = entry.events.length > 1;
  const seq = merged ? `#${first.seq}–${last.seq}` : `#${first.seq}`;
  const thinking = first.type === "run.progress" && first.data?.kind === "thinking";
  const truncated = entry.events.some(event => event.data?.previewTruncated === true || event.data?.detailTruncated === true);
  return <details className={`trace-row trace-category-${presentation.category}${presentation.failed ? " trace-failed" : ""}`} onToggle={event => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) setRawOpen(false);
  }}>
    <summary>
      <svg className="trace-chevron" aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 3 5 5-5 5" /></svg>
      <span className="trace-seq" title={seq}>{seq}</span>
      <span className="trace-category">{CATEGORY_NAMES[presentation.category]}</span>
      <strong className="trace-label">{presentation.label}{merged ? ` · ${entry.events.length} 片段` : ""}</strong>
      <span className="trace-preview">{presentation.summary}</span>
      <time className="trace-time" dateTime={first.ts}>{eventTime(first.ts)}</time>
    </summary>
    {open && <div className="trace-detail">
      <p><code>{first.type}</code>{typeof first.data?.kind === "string" && <> · <code>{first.data.kind}</code></>} · {seq} · {entry.events.length} 条原始事件</p>
      {thinking && <p>本页已记录的思考片段；相邻流式片段按原文拼接，跨页部分请翻页查看。</p>}
      {truncated && <p>部分文本在记录前已被截断；更早的完整内容请查阅原生 Harness Session。</p>}
      {entry.recordedText !== undefined && <pre className="trace-output">{entry.recordedText}</pre>}
      <details className="trace-raw" onToggle={event => setRawOpen(event.currentTarget.open)}>
        <summary>查看原始事件{merged ? `（${entry.events.length} 条）` : ""}</summary>
        {rawOpen && entry.events.map(event => <div key={event.seq}><p>#{event.seq} · <time dateTime={event.ts}>{event.ts}</time></p><pre>{eventDataJson(event)}</pre></div>)}
      </details>
    </div>}
  </details>;
}

export function EventTimeline({ history, runtime, onPage }: {
  history: EventHistory;
  runtime: string;
  onPage: (direction: "previous" | "next" | "refresh") => void;
}) {
  const { events, hasMore, hasMoreInPage, hasPrevious, loading, page } = history;
  const [query, setQuery] = useState("");
  const rows = useMemo(() => buildTimelineEntries(events, runtime).map(entry => ({ entry, searchText: timelineEntrySearchText(entry) })), [events, runtime]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => normalizedQuery ? rows.filter(row => row.searchText.includes(normalizedQuery)) : rows, [rows, normalizedQuery]);
  const firstSeq = events[0]?.seq;
  const lastSeq = events.at(-1)?.seq;
  return <div className="event-timeline">
    {history.error && <div className="notice error" role="alert">轨迹读取失败：{history.error} <button disabled={loading} onClick={() => onPage("refresh")}>重试读取轨迹</button></div>}
    <div className="trace-toolbar">
      <p className="trace-count" aria-live="polite">第 {page + 1} 页 · {events.length} 条原始事件 · {rows.length} 个展示条目{firstSeq !== undefined ? ` · #${firstSeq}–${lastSeq}` : ""}{normalizedQuery ? ` · 匹配 ${visible.length} 项` : ""}{loading ? " · 读取中…" : ""}</p>
      <label className="trace-search"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索本页完整已记录文本" aria-label="搜索本页轨迹" /></label>
    </div>
    <div className="trace-history" aria-label="轨迹历史分页">
      <button disabled={!hasPrevious || loading} onClick={() => onPage("previous")}>上一页轨迹</button>
      <span>{eventHistoryStatus(history)} 每页最多 500 条原始事件。</span>
      <button disabled={!hasMore || loading} onClick={() => onPage("next")}>{loading ? "读取中…" : hasMoreInPage ? "继续读取本页" : "下一页轨迹"}</button>
    </div>
    <div className="trace-list" aria-label="Worker 执行轨迹" aria-busy={loading}>
      {visible.map(row => <TimelineRow key={row.entry.events[0]!.seq} entry={row.entry} />)}
      {!visible.length && <p className="trace-empty">{loading ? "正在读取已记录的事件…" : history.error ? "未能读取轨迹，请重试。" : !history.loaded ? "轨迹尚未读取。" : normalizedQuery ? "本页没有匹配的事件；可翻页搜索其它历史。" : "暂无已记录的事件。"}</p>}
    </div>
  </div>;
}
