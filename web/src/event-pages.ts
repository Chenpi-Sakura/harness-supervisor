import type { TimelineEvent } from "./event-presentation";

export const EVENT_PAGE_SIZE = 500;
const REQUEST_SIZE = 100;
const MAX_BATCHES = 5;

export interface EventPage {
  events: TimelineEvent[];
  nextSeq: number;
  hasMore: boolean;
}

export interface EventHistory {
  events: TimelineEvent[];
  page: number;
  nextSeq: number;
  hasPrevious: boolean;
  hasMore: boolean;
  hasMoreInPage: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

export function emptyEventHistory(): EventHistory {
  return { events: [], page: 0, nextSeq: 0, hasPrevious: false, hasMore: false, hasMoreInPage: false, loading: false, loaded: false, error: null };
}

export function eventHistoryStatus(history: EventHistory): string {
  if (!history.loaded) return history.loading ? "正在读取已记录轨迹…" : "轨迹尚未读取成功。";
  if (history.error) return "轨迹读取失败，保留上次已读取记录。";
  if (history.hasMoreInPage) return "本页还有已记录轨迹，正在分批读取。";
  return history.hasMore ? "后面还有已记录轨迹，请读取下一页。" : "已读至当前记录末尾。";
}

/** Keep only one bounded page in memory. Older pages remain accessible by cursor. */
export class EventPager {
  private current = emptyEventHistory();
  private starts = [0];
  private ends: (number | undefined)[] = [];
  private disposed = false;
  private busy = false;
  private fetchPage: (sinceSeq: number, limit: number) => Promise<EventPage>;
  private publish: (history: EventHistory) => void;

  constructor(fetchPage: (sinceSeq: number, limit: number) => Promise<EventPage>, publish: (history: EventHistory) => void) {
    this.fetchPage = fetchPage;
    this.publish = publish;
  }

  dispose() { this.disposed = true; }

  async read(direction: "refresh" | "previous" | "next" = "refresh"): Promise<void> {
    if (this.disposed || this.busy) return;
    const before = this.current;
    if ((direction === "previous" && !before.hasPrevious) || (direction === "next" && !before.hasMore)) return;
    // Revisiting an old page can take several bounded reads if the backend
    // returns shorter batches. Finish that frozen range before advancing.
    if (direction === "next" && before.hasMoreInPage) direction = "refresh";
    this.busy = true;
    this.update({ ...before, loading: true });
    try {
      // A full page stays in place as new events arrive. Only probe for the next
      // page; never silently evict the history the user is currently reading.
      if (direction === "refresh" && before.events.length >= EVENT_PAGE_SIZE) {
        const probe = await this.fetchPage(before.nextSeq, 1);
        if (!this.disposed) this.update({ ...before, hasMore: probe.events.length > 0 || probe.hasMore, loading: false, loaded: true, error: null });
        return;
      }
      const page = before.page + (direction === "previous" ? -1 : direction === "next" ? 1 : 0);
      const startSeq = direction === "next" ? this.starts[page] ?? before.nextSeq : this.starts[page]!;
      const events = direction === "refresh" ? [...before.events] : [];
      let nextSeq = direction === "refresh" ? before.nextSeq : startSeq;
      let hasMore = false;
      // When revisiting a page, its known end is stable even if the log grew.
      const endSeq = this.starts[page + 1] ?? this.ends[page];
      for (let batch = 0; batch < MAX_BATCHES && events.length < EVENT_PAGE_SIZE; batch++) {
        const response = await this.fetchPage(nextSeq, Math.min(REQUEST_SIZE, EVENT_PAGE_SIZE - events.length));
        if (this.disposed) return;
        const added = response.events.filter(event => event.seq > nextSeq && (endSeq === undefined || event.seq <= endSeq));
        events.push(...added);
        const cursor = endSeq === undefined ? response.nextSeq : Math.min(response.nextSeq, endSeq);
        if (response.hasMore && cursor <= nextSeq && endSeq !== nextSeq) throw new Error("事件分页游标未前进，请重试。");
        nextSeq = cursor;
        hasMore = response.hasMore || this.starts[page + 1] !== undefined ||
          (endSeq !== undefined && (nextSeq < endSeq || response.events.some(event => event.seq > endSeq)));
        if (!response.hasMore || endSeq !== undefined && nextSeq >= endSeq) break;
      }
      if (direction !== "refresh" && this.ends[before.page] === undefined) this.ends[before.page] = before.nextSeq;
      if (direction === "next" && this.starts[page] === undefined) this.starts[page] = startSeq;
      if (events.length >= EVENT_PAGE_SIZE && this.ends[page] === undefined) this.ends[page] = nextSeq;
      this.update({ events, page, nextSeq, hasPrevious: page > 0, hasMore, hasMoreInPage: endSeq !== undefined && nextSeq < endSeq, loading: false, loaded: true, error: null });
    } catch (failure) {
      this.update({ ...before, loading: false, error: failure instanceof Error ? failure.message : "轨迹读取失败" });
      throw failure;
    } finally {
      this.busy = false;
      if (!this.disposed && this.current.loading) this.update({ ...before, loading: false });
    }
  }

  private update(history: EventHistory) {
    if (this.disposed) return;
    this.current = history;
    this.publish(history);
  }
}
