import { harnessName, modelDisplay } from "./harness-catalog";
import { VERSION } from "../../src/version";
import { UiIcon } from "./UiIcon";
import { ResizeHandle } from "./ResizeHandle";
import { WorkerRelations, demoRelationWorkers } from "./WorkerRelations";
import React, { useCallback, useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { TaskPrompt, type PromptDetail } from "./TaskPrompt";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { HarnessIcon } from "./harness-icons";
import { EventTimeline } from "./EventTimeline";
import { emptyEventHistory, EventPager, type EventPage, type EventHistory } from "./event-pages";
import { WorkerNavigation } from "./WorkerNavigation";
import { chooseWorkerSelection, mergeWorkerLists, mergeWorkerPages, workerPageCursor, type WorkerListCursor, type WorkerListPage } from "./worker-pages";
import "./style.css";

interface PendingInput {
  requestId: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  expiresAt?: string;
}
interface Worker {
  runtimeInfo?: { modelId?: string; modelName?: string; reasoningEffort?: string; adapter?: string };
  config?: { model?: string };
  model?: string;
  id: string;
  name?: string;
  ownerRef?: string;
  runtime: string;
  status: string;
  lifecycle: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  cwd: string;
  promptPreview: string;
  result?: { text: string; truncated: boolean };
  error?: string;
  statusReason?: string;
  persistence: string;
  pendingInput?: PendingInput;
}
interface Usage {
  id: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  attribution: string;
  confidence: string;
  modelId?: string;
}
interface Session { version: string; ownerRef: string | null; preferredOwnerRef?: string | null; expiresAt: string }
type Answer = { value: string } | { confirmed: boolean } | { cancelled: true };

const ACTIVE = new Set(["starting", "running", "awaiting_input"]);
const STORAGE_KEY = `hs-ui:${location.pathname}`;

function storedToken(): string | null {
  try { return sessionStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function persistToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(STORAGE_KEY, token);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* Restricted iframe storage: keep the credential in memory. */ }
}
function label(status: string) {
  return ({ starting: "启动中", running: "执行中", awaiting_input: "等待输入", completed: "已完成", failed: "失败", cancelled: "已取消", crashed: "进程异常", orphaned: "失去控制", interrupted: "已中断" } as Record<string, string>)[status] ?? status;
}



class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function App({ demo = false }: { demo?: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Worker | null>(null);
  const [eventHistory, setEventHistory] = useState(emptyEventHistory);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [usageAvailable, setUsageAvailable] = useState(true);
  const [hasMoreWorkers, setHasMoreWorkers] = useState(false);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [drawerWidth, setDrawerWidth] = useState(480);
  const [drawerTop, setDrawerTop] = useState(119);
  const [displayScope, setDisplayScope] = useState<"session" | "project">("session");
  const [sceneDirection, setSceneDirection] = useState<-1 | 1>(-1);
  const [canvasOwnerRef, setCanvasOwnerRef] = useState<string | undefined>();
  const [projectCwd, setProjectCwd] = useState<string | undefined>();
  const [drawerLeft, setDrawerLeft] = useState(280);
  const [drawerMaximized, setDrawerMaximized] = useState(false);
  const drawerElement = useRef<HTMLElement>(null);
  const previousDrawerBounds = useRef<DOMRect | null>(null);
  const resizeAnimation = useRef<Animation | null>(null);
  const drawerTransitionId = useRef(0);
  function toggleDrawerSize() {
    if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const id = ++drawerTransitionId.current;
      document.documentElement.classList.add("detail-resizing");
      const transition = document.startViewTransition(() => flushSync(() => setDrawerMaximized(value => !value)));
      void transition.ready.catch(() => undefined);
      void transition.finished.finally(() => { if (drawerTransitionId.current === id) document.documentElement.classList.remove("detail-resizing"); }).catch(() => undefined);
    } else {
      previousDrawerBounds.current = drawerElement.current?.getBoundingClientRect() ?? null;
      setDrawerMaximized(value => !value);
    }
  }
  useLayoutEffect(() => {
    const element = drawerElement.current;
    const before = previousDrawerBounds.current;
    previousDrawerBounds.current = null;
    if (!element || !before || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    resizeAnimation.current?.cancel();
    const after = element.getBoundingClientRect();
    resizeAnimation.current = element.animate([
      { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})`, transformOrigin: "top left" },
      { transform: "translate(0, 0) scale(1, 1)", transformOrigin: "top left" },
    ], { duration: 280, easing: "cubic-bezier(.25,.1,.25,1)" });
    return () => resizeAnimation.current?.cancel();
  }, [drawerMaximized]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMounted, setDrawerMounted] = useState(false);
  useEffect(() => {
    if (drawerOpen) { setDrawerMounted(true); return; }
    const timer = window.setTimeout(() => setDrawerMounted(false), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220);
    return () => window.clearTimeout(timer);
  }, [drawerOpen]);
  const view = "relations";

  const [panel, setPanel] = useState<"result" | "events">("result");
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => window.matchMedia("(max-width: 620px)").matches);
  useEffect(() => {
    if (view !== "relations") return;
    const toolbar = document.querySelector(".relations-toolbar");
    if (!toolbar) return;
    const update = () => { const bounds = toolbar.getBoundingClientRect(); setDrawerTop(bounds.bottom); setDrawerLeft(bounds.left); };
    const observer = new ResizeObserver(update);
    observer.observe(toolbar);
    window.addEventListener("resize", update);
    update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, [view, sidebarWidth, navigationCollapsed, token]);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const eventPager = useRef<EventPager | null>(null);
  const listPages = useRef(1);
  const globalCursor = useRef<WorkerListCursor | undefined>(undefined);
  const listRevision = useRef(0);
  const paging = useRef(false);
  const detailRef = useRef<Worker | null>(null);
  const preferredOwnerRef = session?.preferredOwnerRef ?? session?.ownerRef ?? undefined;

  function toggleTheme() {
    const update = () => flushSync(() => setTheme(value => value === "light" ? "dark" : "light"));
    if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const transition = document.startViewTransition(update);
      // A newer click or an inactive document may skip the visual transition.
      void transition.ready.catch(() => undefined);
    } else update();
  }

  function expire(message: string) {
    persistToken(null);
    setToken(null);
    setSession(null);
    setWorkers([]);
    setDetail(null);
    detailRef.current = null;
    globalCursor.current = undefined;
    listPages.current = 1;
    listRevision.current += 1;
    setError(message);
  }

  async function request<T>(path: string, auth: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (demo) {
      if (body !== undefined) throw new Error("界面预览不执行任务操作");
      const demoWorkers = demoRelationWorkers.map((worker, index) => ({ ...worker, createdAt: new Date(Date.UTC(2026, 10, 14, 8, index)).toISOString(), updatedAt: "2026-11-14T09:00:00Z" }));
      const worker = demoWorkers.find(item => item.id === decodeURIComponent(path.split("/")[2] ?? ""));
      let value: unknown;
      if (path.startsWith("/workers?")) value = { workers: demoWorkers, hasMore: false, nextCursor: null };
      else if (path.endsWith("/status")) value = { worker };
      else if (path.endsWith("/usage")) value = { available: true, usage: [] };
      else if (path.endsWith("/prompt")) value = { text: worker?.promptPreview ?? "", available: true };
      else if (path.includes("/events")) value = { events: [], nextSeq: 0, hasMore: false };
      else throw new Error("未提供该演示数据");
      return value as T;
    }
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { Authorization: `Bearer ${auth}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.error?.message ?? "请求失败", response.status);
    return data as T;
  }

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    async function connect() {
      if (demo) { setToken("interface-preview"); setSession({ version: VERSION + " · 演示数据", ownerRef: null, preferredOwnerRef: "demo:project-workspace", expiresAt: "2099-01-01T00:00:00Z" }); setConnecting(false); return; }
      try {
        const params = new URLSearchParams(location.hash.slice(1));
        const launchToken = params.get("launch");
        // Remove the one-time secret before any API or external navigation.
        if (location.hash) history.replaceState(null, "", location.pathname);
        let auth = storedToken();
        if (launchToken) {
          const viewId = location.pathname.match(/^\/view\/([0-9a-f]{32})\/$/)?.[1];
          const response = await fetch("/api/exchange", {
            method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ launchToken, viewId }), signal: controller.signal,
          });
          const data = await response.json();
          if (!response.ok) throw new ApiError(data.error?.message ?? "连接失败", response.status);
          auth = data.token;
        }
        if (!auth) throw new Error("请从 harness-sup ui 或 DSH 插件重新打开此页面。");
        const identity = await request<Session>("/session", auth, undefined, controller.signal);
        if (disposed) return;
        persistToken(auth);
        setToken(auth);
        setSession(identity);
      } catch (failure) {
        if (!disposed) expire(failure instanceof Error ? failure.message : "连接失败");
      } finally {
        if (!disposed) setConnecting(false);
      }
    }
    void connect();
    return () => { disposed = true; controller.abort(); };
  }, []);

  useEffect(() => {
    if (!token) return;
    const auth = token;
    const controller = new AbortController();
    let disposed = false;
    let running = false;
    setDetail(null);
    detailRef.current = null;
    setUsage([]);
    setCancelConfirm(false);
    async function refresh() {
      if (document.hidden || running || disposed) return;
      running = true;
      try {
        const revision = listRevision.current;
        const pageCount = listPages.current;
        const pages: WorkerListPage<Worker>[] = [];
        let after = "";
        for (let index = 0; index < pageCount; index++) {
          const list = await request<WorkerListPage<Worker>>(`/workers?limit=100${after}`, auth, undefined, controller.signal);
          pages.push(list);
          const last = workerPageCursor(list);
          if (!list.hasMore || !last) break;
          after = `&afterId=${encodeURIComponent(last.id)}&afterCreatedAt=${encodeURIComponent(last.createdAt)}`;
        }
        if (disposed) return;
        const fresh = mergeWorkerPages(pages);
        // A slow refresh must not discard a page the user loaded meanwhile.
        if (revision === listRevision.current && !paging.current) {
          globalCursor.current = fresh.cursor;
          setWorkers(fresh.workers);
          setHasMoreWorkers(fresh.hasMore);
          setSelected(previous => chooseWorkerSelection(fresh.workers, previous, preferredOwnerRef));
        }
        if (selected && fresh.workers.some(worker => worker.id === selected)) {
          const id = encodeURIComponent(selected);
          const [status, metered] = await Promise.all([
            request<{ worker: Worker }>(`/workers/${id}/status`, auth, undefined, controller.signal),
            request<{ available: boolean; usage: Usage[] }>(`/workers/${id}/usage`, auth, undefined, controller.signal),
          ]);
          if (disposed) return;
          setDetail(status.worker);
          detailRef.current = status.worker;
          setUsage(metered.usage);
          setUsageAvailable(metered.available);
        }
        setError("");
      } catch (failure) {
        if (disposed) return;
        if (failure instanceof ApiError && failure.status === 401) expire(failure.message);
        else setError(failure instanceof Error ? failure.message : "刷新失败");
      } finally { running = false; }
    }
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 5000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [token, selected, preferredOwnerRef]);

  useEffect(() => {
    setEventHistory(emptyEventHistory());
    if (!token || !selected) return;
    const auth = token;
    const controller = new AbortController();
    let disposed = false;
    const pager = new EventPager((sinceSeq, limit) => request<EventPage>(
      `/workers/${encodeURIComponent(selected)}/events?sinceSeq=${sinceSeq}&limit=${limit}`, auth, undefined, controller.signal,
    ), setEventHistory);
    eventPager.current = pager;
    async function refresh() {
      if (document.hidden || disposed) return;
      try { await pager.read(); }
      catch (failure) {
        if (disposed) return;
        if (failure instanceof ApiError && failure.status === 401) expire(failure.message);
      }
    }
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 5000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      pager.dispose();
      controller.abort();
      if (eventPager.current === pager) eventPager.current = null;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [token, selected]);

  async function pageEvents(direction: "previous" | "next" | "refresh") {
    const pager = eventPager.current;
    if (!pager) return;
    try { await pager.read(direction); }
    catch (failure) {
      if (eventPager.current !== pager) return;
      if (failure instanceof ApiError && failure.status === 401) expire(failure.message);
    }
  }

  async function act(action: "answer" | "cancel", body: unknown) {
    if (!token || !detail || busy) return;
    const id = detail.id;
    setBusy(true);
    setError("");
    try {
      const worker = await request<Worker>(`/workers/${encodeURIComponent(id)}/${action}`, token, body);
      if (detailRef.current?.id === id) setDetail(worker);
      setWorkers(previous => previous.map(item => item.id === id ? worker : item));
      setCancelConfirm(false);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) expire(failure.message);
      else setError(failure instanceof Error ? failure.message : "操作失败");
    } finally { setBusy(false); }
  }

  async function olderWorkers() {
    const last = globalCursor.current;
    if (!token || !last || busy || paging.current) return;
    paging.current = true;
    listRevision.current += 1;
    setBusy(true);
    try {
      const page = await request<WorkerListPage<Worker>>(`/workers?limit=100&afterId=${encodeURIComponent(last.id)}&afterCreatedAt=${encodeURIComponent(last.createdAt)}`, token);
      listPages.current += 1;
      listRevision.current += 1;
      globalCursor.current = workerPageCursor(page);
      setWorkers(previous => mergeWorkerLists(page.workers, previous));
      setHasMoreWorkers(page.hasMore);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) expire(failure.message);
      else setError(failure instanceof Error ? failure.message : "读取失败");
    } finally { paging.current = false; setBusy(false); }
  }

  const loadPrompt = useCallback((signal: AbortSignal) => {
    if (!token || !detail) return Promise.reject(new Error("请先连接并选择 Worker"));
    return request<PromptDetail>(`/workers/${encodeURIComponent(detail.id)}/prompt`, token, undefined, signal);
  }, [token, detail?.id]);

  return <div className="app" data-theme={theme}>
    <main className={`workspace${navigationCollapsed ? " navigation-collapsed" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      <aside className="workers" aria-label="Worker 列表">
        <div className="section-title">
          <button className="navigation-toggle" onClick={() => setNavigationCollapsed(value => !value)} aria-label={navigationCollapsed ? "展开 Worker 列表" : "收起 Worker 列表"} title={navigationCollapsed ? "展开 Worker 列表" : "收起 Worker 列表"} aria-expanded={!navigationCollapsed} aria-controls="worker-navigation"><UiIcon name="panelLeft" /></button>
          <h2 className="sidebar-copy" aria-hidden={navigationCollapsed}>Workers <span>{workers.length}{hasMoreWorkers ? "+" : ""}</span></h2>
        </div>
        <div id="worker-navigation" className="worker-scroll sidebar-copy" inert={navigationCollapsed} aria-hidden={navigationCollapsed}>
          <div className="navigation-inner">
            {!token ? <p className="navigation-empty">连接后查看 Worker。</p> : workers.length === 0 && !preferredOwnerRef ? <div className="empty small"><h3>暂无 Worker</h3><p>由 Master 发起任务后，会出现在这里。</p></div> : <><WorkerNavigation key={JSON.stringify([preferredOwnerRef ?? null])} workers={workers} selected={selected} activeProjectCwd={projectCwd ?? workers.find(worker => worker.ownerRef === preferredOwnerRef)?.cwd} activeOwnerRef={canvasOwnerRef ?? preferredOwnerRef} onProjectSelect={(cwd, direction) => { setDisplayScope("project"); setSceneDirection(direction); setProjectCwd(cwd); setCanvasOwnerRef(undefined); setDrawerOpen(false); }} onSessionSelect={(cwd, owner, direction) => { setDisplayScope("session"); setSceneDirection(direction); setProjectCwd(cwd); setCanvasOwnerRef(owner ?? ""); setDrawerOpen(false); }} onSelect={id => { setProjectCwd(workers.find(worker => worker.id === id)?.cwd); setCanvasOwnerRef(workers.find(worker => worker.id === id)?.ownerRef ?? ""); setSelected(id); setDrawerOpen(true); }} preferredOwnerRef={preferredOwnerRef} /></>}
            {token && hasMoreWorkers && <button className="load-more" disabled={busy} onClick={() => { void olderWorkers(); }}>读取更早的 Worker</button>}
          </div>
        </div>
        <header className="page-heading" aria-label="Harness Supervisor">
          <div className="brand"><span className="brand-mark" aria-hidden="true">HS</span><h1 className="sidebar-copy" aria-hidden={navigationCollapsed}>Harness Supervisor</h1></div>
          <div className="header-actions"><span className={`connection sidebar-copy ${token ? "connected" : ""}`} aria-hidden={navigationCollapsed}><span aria-hidden="true" />{connecting ? "连接中" : token ? "本机已连接" : "未连接"}</span><button className="theme-toggle" onClick={toggleTheme} aria-label={theme === "light" ? "切换深色外观" : "切换浅色外观"}><span className="theme-label">{theme === "light" ? "深色" : "浅色"}</span><UiIcon name={theme === "dark" ? "sun" : "moon"} /></button></div>
          <div className="scope sidebar-copy" inert={navigationCollapsed} aria-hidden={navigationCollapsed}>
            <strong>{session ? session.ownerRef ? "当前会话 Worker" : "本机全部 Worker" : "等待认证"}</strong>
            {session?.ownerRef ? <span className="scope-reference" title={session.ownerRef}>{session.ownerRef}</span> : preferredOwnerRef && <span title={preferredOwnerRef}>默认展开当前会话</span>}
            {session && <small>v{session.version} · {session.ownerRef ? "仅此会话" : "全局管理"}</small>}
          </div>
        </header>
      {!navigationCollapsed && <ResizeHandle label="调整会话栏宽度" width={sidebarWidth} onWidth={setSidebarWidth} max={520} />}
      </aside>
      <div className={`workspace-content${drawerOpen && view === "relations" ? " has-worker-drawer" : ""}`} style={{ "--drawer-width": `${drawerWidth}px` } as React.CSSProperties}>
      {error && <div className="notice error workspace-error" role="alert">{error}</div>}
      {token ? <div><WorkerRelations workers={workers} onGroupSelect={owner => { setCanvasOwnerRef(owner); setDisplayScope("session"); setDrawerOpen(false); }} displayScope={displayScope} onScopeChange={value => { setDisplayScope(value); setDrawerOpen(false); }} transitionDirection={sceneDirection} selectedWorkerId={drawerOpen ? selected : null} selectedOwnerRef={canvasOwnerRef} projectCwd={projectCwd} onProjectChange={cwd => { setProjectCwd(cwd); setDrawerOpen(false); }} preferredOwnerRef={preferredOwnerRef} onOpen={id => { setSelected(id); setDrawerOpen(true); }} demo={demo} /></div> : <section className="detail" aria-label="Worker 详情">
        {!token ? <div className="empty welcome"><span className="empty-icon" aria-hidden="true">◇</span><h2>{connecting ? "正在连接 Supervisor" : "从可信入口连接"}</h2><p>通过命令行 <code>harness-sup ui</code> 或 DSH 的 Harness Supervisor 入口打开。连接仅限本机。</p><p className="muted">服务重启后需要重新打开入口。关闭页面不会取消 Worker。</p></div> : !detail ? <div className="empty"><h2>{selected ? "读取 Worker…" : preferredOwnerRef ? "当前会话暂无 Worker" : "选择一个 Worker"}</h2><p>{preferredOwnerRef && !selected ? "可以展开左侧其它会话，查看已有 Worker。" : "查看运行状态、结果与需要你处理的输入。"}</p></div> : <>
          <WorkerDetails key={detail.id} detail={detail} usage={usage} usageAvailable={usageAvailable} eventHistory={eventHistory} loadPrompt={loadPrompt} act={act} pageEvents={pageEvents} busy={busy} readOnly={demo} />
        </>}
      </section>}
      {drawerMounted && view === "relations" && <aside ref={drawerElement} className={`workspace-drawer${drawerOpen ? " is-open" : " is-closing"}${drawerMaximized ? " is-maximized" : ""}`} inert={!drawerOpen} aria-hidden={!drawerOpen} style={{ top: drawerTop, ...(drawerMaximized ? { left: drawerLeft, width: `calc(100vw - ${drawerLeft}px)` } : {}) }} aria-label="Worker 详情侧栏">{!drawerMaximized && <ResizeHandle label="调整详情栏宽度" width={drawerWidth} onWidth={setDrawerWidth} direction={-1} min={320} max={800} />}<div className="drawer-title"><span>Worker 详情</span><div className="drawer-actions"><button className="drawer-maximize" aria-label={drawerMaximized ? "还原详情" : "最大化详情"} title={drawerMaximized ? "还原详情" : "最大化详情"} aria-pressed={drawerMaximized} onClick={toggleDrawerSize}><UiIcon name={drawerMaximized ? "minimize" : "maximize"} /></button><button aria-label="关闭详情侧栏" onClick={() => setDrawerOpen(false)}><UiIcon name="close" /></button></div></div><div className="drawer-scroll">{detail ? <WorkerDetails key={detail.id} detail={detail} usage={usage} usageAvailable={usageAvailable} eventHistory={eventHistory} loadPrompt={loadPrompt} act={act} pageEvents={pageEvents} busy={busy} readOnly={demo} /> : <p>读取 Worker…</p>}</div></aside>}
      </div>
    </main>
  </div>;
}

function WorkerDetails({ detail, usage, usageAvailable, eventHistory, loadPrompt, act, pageEvents, busy, readOnly = false }: {
  detail: Worker; usage: Usage[]; usageAvailable: boolean; eventHistory: EventHistory;
  loadPrompt: (signal: AbortSignal) => Promise<PromptDetail>;
  act: (action: "answer" | "cancel", body: unknown) => Promise<void>;
  pageEvents: (direction: "previous" | "next" | "refresh") => void | Promise<void>;
  busy: boolean; readOnly?: boolean;
}) {
  const [panel, setPanel] = useState<"result" | "events">("result");
  const [cancelConfirm, setCancelConfirm] = useState(false);
  return <>          <div className="detail-overview">
            <div className="detail-heading"><div className="worker-identity"><div className="eyebrow harness-caption"><HarnessIcon runtime={detail.runtime} />{harnessName(detail.runtime)}<span aria-hidden="true"> / </span>{detail.persistence === "persistent" ? "持续会话" : "单次任务"}</div><h2>{detail.name ?? detail.id}</h2></div><div className="detail-subline"><span className={`badge ${detail.status}`}><span className={`status-dot ${detail.status}`} aria-hidden="true" />{label(detail.status)}</span><time>{new Date(detail.updatedAt).toLocaleString()}</time></div></div>
            <div className="task-context">
              <TaskPrompt key={`${detail.id}:${detail.startedAt ?? ""}:${detail.promptPreview}`} preview={detail.promptPreview} load={loadPrompt} />
              <RuntimeInformation worker={detail} />
            </div>
          </div>
          {detail.pendingInput && <Approval key={detail.pendingInput.requestId} input={detail.pendingInput} busy={busy} onAnswer={response => { void act("answer", { requestId: detail.pendingInput!.requestId, response }); }} />}
          <UsageDisplay usage={usage} available={usageAvailable} />
          <div className="tabs" role="tablist" aria-label="详情内容" onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "result" : event.key === "End" ? "events" : panel === "result" ? "events" : "result";
            setPanel(next);
            document.getElementById(`tab-${next}`)?.focus();
          }}>
            <button id="tab-result" role="tab" aria-controls="panel-result" aria-selected={panel === "result"} tabIndex={panel === "result" ? 0 : -1} onClick={() => setPanel("result")}>结果</button>
            <button id="tab-events" role="tab" aria-controls="panel-events" aria-selected={panel === "events"} tabIndex={panel === "events" ? 0 : -1} onClick={() => setPanel("events")}>轨迹</button>
          </div>
          {panel === "result" ? <div className="result-panel" id="panel-result" role="tabpanel" aria-labelledby="tab-result" tabIndex={0}>{detail.result ? <><Markdown text={detail.result.text} />{detail.result.truncated && <p className="muted">结果已被存储上限截断，完整内容请查阅原生 Harness Session。</p>}</> : <div className="empty small"><h3>{ACTIVE.has(detail.status) ? "任务正在执行" : detail.status === "cancelled" ? "任务已取消" : "暂无最终结果"}</h3><p>{ACTIVE.has(detail.status) ? "最终答复会显示在这里。运行过程可在轨迹中查看。" : "可在轨迹中查看已记录的执行过程。"}</p></div>}{detail.error && detail.status !== "cancelled" && <p className="notice error" role="alert">{detail.error}</p>}</div> : <div className="events-panel" id="panel-events" role="tabpanel" aria-labelledby="tab-events" tabIndex={0}><EventTimeline key={detail.id} history={eventHistory} runtime={detail.runtime} onPage={direction => { void pageEvents(direction); }} /></div>}
          {!readOnly && ACTIVE.has(detail.status) && <div className="danger-zone">{cancelConfirm ? <><p>取消此 Worker 的当前任务？此操作会请求终止执行。</p><div className="actions"><button className="danger" disabled={busy} onClick={() => { void act("cancel", {}); }}>{busy ? "正在处理…" : "确认取消任务"}</button><button disabled={busy} onClick={() => setCancelConfirm(false)}>继续运行</button></div></> : <button className="subtle-danger" disabled={busy} onClick={() => setCancelConfirm(true)}>取消当前任务</button>}</div>}</>;
}

function RuntimeInformation({ worker }: { worker: Worker }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return <section className={`metadata${open ? " is-open" : ""}`}>
    <button className="metadata-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>运行信息<UiIcon name="chevronDown" size={14} className="metadata-chevron" /></button>
    <div className="metadata-content" id={panelId} inert={!open} aria-hidden={!open}><div className="metadata-inner">
      <dl><div><dt>Harness</dt><dd>{harnessName(worker.runtime)}</dd></div><div><dt>模型</dt><dd>{modelDisplay(worker)}</dd></div>{worker.runtimeInfo?.modelId && <div><dt>模型标识</dt><dd>{worker.runtimeInfo.modelId}</dd></div>}{worker.runtimeInfo?.reasoningEffort && <div><dt>推理强度</dt><dd>{worker.runtimeInfo.reasoningEffort}</dd></div>}{worker.runtimeInfo?.adapter && <div><dt>ACP Adapter</dt><dd>{worker.runtimeInfo.adapter}</dd></div>}<div><dt>Worker ID</dt><dd>{worker.id}</dd></div><div><dt>工作目录</dt><dd>{worker.cwd}</dd></div><div><dt>生命周期</dt><dd>{worker.lifecycle}</dd></div>{worker.statusReason && <div><dt>状态说明</dt><dd>{worker.statusReason}</dd></div>}</dl>
    </div></div>
  </section>;
}

function Approval({ input, busy, onAnswer }: { input: PendingInput; busy: boolean; onAnswer: (response: Answer) => void }) {
  const [value, setValue] = useState(input.prefill ?? "");
  const expired = input.expiresAt !== undefined && Date.parse(input.expiresAt) <= Date.now();
  return <section className="approval" aria-label="待处理输入"><div className="eyebrow"><span className="approval-mark" aria-hidden="true">!</span>需要人工处理{expired ? " · 请求已过期" : ""}</div><h3>{input.title ?? "Worker 等待你的输入"}</h3>{input.message && <p>{input.message}</p>}{input.expiresAt && <small>截止时间：{new Date(input.expiresAt).toLocaleString()}</small>}<div className="approval-content">
    {input.method === "confirm" ? <div className="actions"><button className="primary" disabled={busy || expired} onClick={() => onAnswer({ confirmed: true })}>允许</button><button disabled={busy || expired} onClick={() => onAnswer({ confirmed: false })}>拒绝</button></div> : input.method === "select" ? <div className="options">{input.options?.map((option, index) => <button disabled={busy || expired} key={index} onClick={() => onAnswer({ value: option })}>{option}</button>)}</div> : <><label className="field-label" htmlFor="input-response">回复内容</label><textarea id="input-response" rows={input.method === "editor" ? 7 : 3} value={value} placeholder={input.placeholder} disabled={busy || expired} onChange={event => setValue(event.target.value)} /><button className="primary" disabled={busy || expired} onClick={() => onAnswer({ value })}>发送回复</button></>}
    <button className="text-button" disabled={busy || expired} onClick={() => onAnswer({ cancelled: true })}>取消此输入</button>
  </div></section>;
}

function UsageDisplay({ usage, available }: { usage: Usage[]; available: boolean }) {
  function total(field: "inputTokens" | "outputTokens" | "cacheReadTokens") {
    const known = usage.map(record => record[field]).filter((value): value is number => value !== null);
    if (!known.length) return "0";
    const value = known.reduce((sum, number) => sum + number, 0).toLocaleString();
    return `${value}${known.length < usage.length ? " + ?" : ""}`;
  }
  return <section className="usage" aria-label="Worker 用量"><div><small>输入 Token</small><strong>{total("inputTokens")}</strong></div><div><small>输出 Token</small><strong>{total("outputTokens")}</strong></div><div><small>缓存读取</small><strong>{total("cacheReadTokens")}</strong></div><p>{!available ? "用量服务不可用，暂显示 0" : usage.length ? `${usage.length} 条 Worker 用量记录 · ${usage.some(record => record.attribution === "session_level") ? "含会话级数据" : "按运行时上报"}` : "尚未上报用量，暂显示 0"}</p></section>;
}

function RelationsPreview() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [previewWorker, setPreviewWorker] = useState<string | null>(null);
  const demoWorker = demoRelationWorkers.find(worker => worker.id === previewWorker);
  const demoDetail = demoWorker ? { ...demoWorker, createdAt: "2026-11-14T00:00:00Z", updatedAt: "2026-11-14T00:00:00Z" } as Worker : null;
  return <div className="app" data-theme={theme}><div className="relations-preview-bar"><div className="brand"><span className="brand-mark">HS</span><h1>Harness Supervisor</h1></div><button onClick={() => setTheme(value => value === "dark" ? "light" : "dark")}>{theme === "dark" ? "切换浅色" : "切换深色"}</button></div>{demoDetail ? <><button className="relations-back" onClick={() => setPreviewWorker(null)}>← 返回关系图 · 演示数据</button><section className="detail" aria-label="Worker 详情"><WorkerDetails key={demoDetail.id} detail={demoDetail} usage={[]} usageAvailable={true} eventHistory={{ ...emptyEventHistory(), loaded: true }} loadPrompt={async () => ({ text: demoDetail.promptPreview, available: true })} act={async () => {}} pageEvents={() => {}} busy={false} readOnly /></section></> : <WorkerRelations workers={demoRelationWorkers} preferredOwnerRef="demo:project-workspace" onOpen={setPreviewWorker} demo />}</div>;
}
const developmentPreview = (import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV;
const previewMode = developmentPreview && location.pathname === "/" ? new URLSearchParams(location.search).get("preview") : null;
createRoot(document.getElementById("root")!).render(previewMode === "relations" ? <RelationsPreview /> : <App demo={previewMode === "workspace"} />);
