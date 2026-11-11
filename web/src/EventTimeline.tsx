import React, { useMemo, useState } from "react";
import { eventDataJson, eventSearchText, presentEvent, type EventCategory, type TimelineEvent } from "./event-presentation";

export type { TimelineEvent } from "./event-presentation";

const CATEGORY_NAMES: Record<EventCategory, string> = {
  task: "任务", tool: "工具", output: "模型", input: "交互", system: "系统", error: "异常",
};

function eventTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function EventTimeline({ events, hasMore }: { events: TimelineEvent[]; hasMore: boolean }) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => events.map(event => {
    const presentation = presentEvent(event);
    const dataJson = eventDataJson(event);
    return { event, ...presentation, dataJson, searchText: eventSearchText(event, presentation, dataJson) };
  }), [events]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = normalizedQuery ? rows.filter(row => row.searchText.includes(normalizedQuery)) : rows;
  return <div className="event-timeline">
    <div className="trace-toolbar">
      <p className="trace-count" aria-live="polite">{normalizedQuery ? `${visible.length} / ${rows.length} 条事件` : `显示 ${rows.length} 条事件`}{hasMore ? " · 继续读取中…" : ""}</p>
      <label className="trace-search"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索轨迹" aria-label="搜索轨迹" /></label>
    </div>
    <div className="trace-list" aria-label="Worker 执行轨迹">
      {visible.map(row => <details className={`trace-row trace-category-${row.category}${row.failed ? " trace-failed" : ""}`} key={row.event.seq}>
        <summary>
          <svg className="trace-chevron" aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 3 5 5-5 5" /></svg>
          <span className="trace-seq">#{row.event.seq}</span>
          <span className="trace-category">{CATEGORY_NAMES[row.category]}</span>
          <strong className="trace-label">{row.label}</strong>
          <span className="trace-preview">{row.summary}</span>
          <time className="trace-time" dateTime={row.event.ts}>{eventTime(row.event.ts)}</time>
        </summary>
        <div className="trace-detail"><p><code>{row.event.type}</code>{typeof row.event.data?.kind === "string" && <> · <code>{row.event.data.kind}</code></>}</p><pre>{row.dataJson}</pre></div>
      </details>)}
      {!visible.length && <p className="trace-empty">{normalizedQuery ? "没有匹配的事件。" : "暂无已记录的事件。"}</p>}
    </div>
  </div>;
}
