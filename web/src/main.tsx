import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HarnessIcon } from "./harness-icons";
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
  id: string;
  name?: string;
  ownerRef?: string;
  runtime: string;
  status: string;
  lifecycle: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  promptPreview: string;
  result?: { text: string; truncated: boolean };
  error?: string;
  statusReason?: string;
  persistence: string;
  pendingInput?: PendingInput;
}
interface Event {
  seq: number;
  ts: string;
  type: string;
  data?: Record<string, unknown>;
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
interface Session { version: string; ownerRef: string | null; expiresAt: string }
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
function time(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function label(status: string) {
  return ({ starting: "启动中", running: "执行中", awaiting_input: "等待输入", completed: "已完成", failed: "失败", cancelled: "已取消", crashed: "进程异常", orphaned: "失去控制", interrupted: "已中断" } as Record<string, string>)[status] ?? status;
}

function harnessName(runtime: string) {
  return ({ pi: "Pi", qoder: "Qoder", mcode: "MiniMax Code", dsh: "DSH" } as Record<string, string>)[runtime] ?? runtime;
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function App() {
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Worker | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [usageAvailable, setUsageAvailable] = useState(true);
  const [hasMoreEvents, setHasMoreEvents] = useState(false);
  const [hasMoreWorkers, setHasMoreWorkers] = useState(false);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [panel, setPanel] = useState<"result" | "events">("result");
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const cursor = useRef(0);
  const listPages = useRef(1);
  const detailRef = useRef<Worker | null>(null);

  function expire(message: string) {
    persistToken(null);
    setToken(null);
    setSession(null);
    setWorkers([]);
    setDetail(null);
    setError(message);
  }

  async function request<T>(path: string, auth: string, body?: unknown, signal?: AbortSignal): Promise<T> {
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
    cursor.current = 0;
    setEvents([]);
    setDetail(null);
    detailRef.current = null;
    setUsage([]);
    setHasMoreEvents(false);
    setCancelConfirm(false);
    async function refresh() {
      if (document.hidden || running || disposed) return;
      running = true;
      try {
        const fresh: Worker[] = [];
        let hasMore = false;
        let after = "";
        for (let index = 0; index < listPages.current; index++) {
          const list = await request<{ workers: Worker[]; hasMore: boolean }>(`/workers?limit=100${after}`, auth, undefined, controller.signal);
          fresh.push(...list.workers);
          hasMore = list.hasMore;
          const last = list.workers.at(-1);
          if (!hasMore || !last) break;
          after = `&afterId=${encodeURIComponent(last.id)}&afterCreatedAt=${encodeURIComponent(last.createdAt)}`;
        }
        if (disposed) return;
        setWorkers(fresh);
        setHasMoreWorkers(hasMore);
        if (!selected || !fresh.some(worker => worker.id === selected)) {
          setSelected(fresh[0]?.id ?? null);
        } else {
          const id = encodeURIComponent(selected);
          const [status, page, metered] = await Promise.all([
            request<{ worker: Worker }>(`/workers/${id}/status`, auth, undefined, controller.signal),
            request<{ events: Event[]; nextSeq: number; hasMore: boolean }>(`/workers/${id}/events?sinceSeq=${cursor.current}&limit=100`, auth, undefined, controller.signal),
            request<{ available: boolean; usage: Usage[] }>(`/workers/${id}/usage`, auth, undefined, controller.signal),
          ]);
          if (disposed) return;
          setDetail(status.worker);
          detailRef.current = status.worker;
          cursor.current = page.nextSeq;
          setHasMoreEvents(page.hasMore);
          setEvents(previous => [...previous, ...page.events].slice(-300));
          setUsage(metered.usage);
          setUsageAvailable(metered.available);
        }
        setLastRefreshed(new Date().toISOString());
        setError("");
      } catch (failure) {
        if (disposed) return;
        if (failure instanceof ApiError && failure.status === 401) expire(failure.message);
        else setError(failure instanceof Error ? failure.message : "刷新失败");
      } finally { running = false; }
    }
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 2000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [token, selected]);

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
    if (!token || !workers.length || busy) return;
    const last = workers[workers.length - 1];
    setBusy(true);
    try {
      const page = await request<{ workers: Worker[]; hasMore: boolean }>(`/workers?limit=100&afterId=${encodeURIComponent(last.id)}&afterCreatedAt=${encodeURIComponent(last.createdAt)}`, token);
      listPages.current += 1;
      setWorkers(previous => [...previous, ...page.workers.filter(worker => !previous.some(item => item.id === worker.id))]);
      setHasMoreWorkers(page.hasMore);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "读取失败"); }
    finally { setBusy(false); }
  }

  return <div className="app" data-theme={theme}>
    <header className="masthead">
      <div className="brand"><span className="brand-mark" aria-hidden="true">hs</span><h1>Harness Supervisor</h1></div>
      <div className="header-actions"><span className={`connection ${token ? "connected" : ""}`}><span aria-hidden="true" />{connecting ? "连接中" : token ? "本机已连接" : "未连接"}</span><button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={theme === "light" ? "切换深色外观" : "切换浅色外观"}>{theme === "light" ? "深色" : "浅色"}<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{theme === "dark" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></> : <path d="M20.9 13a9 9 0 0 1-9.9-9.9A9 9 0 1 0 20.9 13Z" />}</svg></button></div>
    </header>
    <div className="scope"><span>当前范围</span><strong>{session?.ownerRef ?? (session ? "本机全部 Worker" : "等待认证")}</strong>{session && <small>v{session.version}<span aria-hidden="true"> / </span>页面固定绑定此范围</small>}</div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!token ? <main className="empty welcome"><span className="empty-icon" aria-hidden="true">◇</span><h2>{connecting ? "正在连接 Supervisor" : "从可信入口连接"}</h2><p>通过命令行 <code>harness-sup ui</code> 或 DSH 的 HS 入口打开。连接仅限本机。</p><p className="muted">服务重启后需要重新打开入口。关闭页面不会取消 Worker。</p></main> : <main className="workspace">
      <aside className="workers" aria-label="Worker 列表">
        <div className="section-title"><h2>Workers <span>{workers.length}</span></h2><small>{lastRefreshed ? time(lastRefreshed) : "正在同步"}</small></div>
        {workers.length === 0 ? <div className="empty small"><h3>暂无 Worker</h3><p>由 Master 发起任务后，会出现在这里。</p></div> : <WorkerNavigation workers={workers} selected={selected} onSelect={setSelected} />}
        {hasMoreWorkers && <button className="load-more" disabled={busy} onClick={() => { void olderWorkers(); }}>读取更早的 Worker</button>}
      </aside>
      <section className="detail" aria-label="Worker 详情">
        {!detail ? <div className="empty"><h2>{selected ? "读取 Worker…" : "选择一个 Worker"}</h2><p>查看运行状态、结果与需要你处理的输入。</p></div> : <>
          <div className="detail-heading"><div className="eyebrow harness-caption"><HarnessIcon runtime={detail.runtime} />{harnessName(detail.runtime)}<span aria-hidden="true"> / </span>{detail.persistence === "persistent" ? "持续会话" : "单次任务"}</div><h2>{detail.name ?? detail.id}</h2><div className="detail-subline"><span className={`badge ${detail.status}`}><span className={`status-dot ${detail.status}`} aria-hidden="true" />{label(detail.status)}</span><time>{new Date(detail.updatedAt).toLocaleString()}</time></div></div>
          <p className="task-description">{detail.promptPreview}</p>
          <details className="metadata"><summary>运行信息<span aria-hidden="true"> ↗</span></summary><dl><div><dt>Worker ID</dt><dd>{detail.id}</dd></div><div><dt>工作目录</dt><dd>{detail.cwd}</dd></div><div><dt>生命周期</dt><dd>{detail.lifecycle}</dd></div>{detail.statusReason && <div><dt>状态说明</dt><dd>{detail.statusReason}</dd></div>}</dl></details>
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
            <button id="tab-events" role="tab" aria-controls="panel-events" aria-selected={panel === "events"} tabIndex={panel === "events" ? 0 : -1} onClick={() => setPanel("events")}>事件 <span>{events.length}{hasMoreEvents ? "+" : ""}</span></button>
          </div>
          {panel === "result" ? <div className="result-panel" id="panel-result" role="tabpanel" aria-labelledby="tab-result" tabIndex={0}>{detail.result ? <><pre>{detail.result.text}</pre>{detail.result.truncated && <p className="muted">结果已被存储上限截断，完整内容请查阅原生 Harness Session。</p>}</> : <div className="empty small"><h3>{ACTIVE.has(detail.status) ? "任务正在执行" : detail.status === "cancelled" ? "任务已取消" : "暂无最终结果"}</h3><p>{ACTIVE.has(detail.status) ? "最终答复会显示在这里。运行过程可在事件中查看。" : "可在事件中查看已记录的执行过程。"}</p></div>}{detail.error && detail.status !== "cancelled" && <p className="notice error" role="alert">{detail.error}</p>}</div> : <div className="events-panel" id="panel-events" role="tabpanel" aria-labelledby="tab-events" tabIndex={0}><p className="muted event-note">按游标增量读取，仅展示最近 300 条已读事件。{hasMoreEvents ? "正在继续读取历史…" : ""}</p>{events.map(event => <article className="event" key={event.seq}><div><span className="event-seq">#{event.seq}</span><strong>{event.type}</strong><time>{time(event.ts)}</time></div>{event.data && <pre>{JSON.stringify(event.data, null, 2)}</pre>}</article>)}</div>}
          {ACTIVE.has(detail.status) && <div className="danger-zone">{cancelConfirm ? <><p>取消此 Worker 的当前任务？此操作会请求终止执行。</p><div className="actions"><button className="danger" disabled={busy} onClick={() => { void act("cancel", {}); }}>{busy ? "正在处理…" : "确认取消任务"}</button><button disabled={busy} onClick={() => setCancelConfirm(false)}>继续运行</button></div></> : <button className="subtle-danger" disabled={busy} onClick={() => setCancelConfirm(true)}>取消当前任务</button>}</div>}
        </>}
      </section>
    </main>}
    <footer><span>Harness Supervisor</span><p>仅限本机。页面隐藏时暂停刷新，关闭页面不会取消任务。</p></footer>
  </div>;
}

function WorkerNavigation({ workers, selected, onSelect }: { workers: Worker[]; selected: string | null; onSelect: (id: string) => void }) {
  const [grouped, setGrouped] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = new Map<string, { cwd: string; workers: Worker[] }>();
  for (const worker of workers) {
    const cwd = worker.cwd;
    // Windows drive/UNC paths are case insensitive; POSIX paths retain case.
    const key = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\") ? cwd.replaceAll("/", "\\").toLowerCase() : cwd;
    const group = groups.get(key) ?? { cwd, workers: [] };
    group.workers.push(worker);
    groups.set(key, group);
  }
  const card = (worker: Worker) => {
    let hash = 0;
    for (const character of worker.id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
    return <button key={worker.id} className={`worker-card worker-tone-${(hash >>> 0) % 6} ${selected === worker.id ? "selected" : ""}`} onClick={() => onSelect(worker.id)} aria-pressed={selected === worker.id}>
    <div className="worker-top"><span className="runtime"><HarnessIcon runtime={worker.runtime} />{harnessName(worker.runtime)}</span><span className={`status-dot ${worker.status}`} aria-label={label(worker.status)} title={label(worker.status)} /></div>
    <strong>{worker.name ?? worker.id}</strong><p>{worker.promptPreview}</p><small>{label(worker.status)}<span aria-hidden="true"> · </span>{time(worker.updatedAt)}</small>
    </button>;
  };
  return <>
    <div className="list-controls" aria-label="任务列表视图"><button aria-pressed={grouped} onClick={() => setGrouped(true)}>按目录</button><button aria-pressed={!grouped} onClick={() => setGrouped(false)}>平铺</button></div>
    {grouped ? [...groups].map(([key, group], index) => {
      const open = !collapsed.has(key);
      const name = group.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? group.cwd;
      return <section className="directory-group" key={key}>
        <button className="directory-toggle" aria-expanded={open} aria-controls={`directory-workers-${index}`} title={group.cwd} onClick={() => setCollapsed(previous => {
          const next = new Set(previous);
          if (next.has(key)) next.delete(key); else next.add(key);
          return next;
        })}><svg aria-hidden="true" className={open ? "expanded" : ""} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 4 4 4-4 4" /></svg><strong>{name}</strong><span>{group.workers.length}</span></button>
        <p className="directory-path" title={group.cwd}>{group.cwd}</p>
        <div id={`directory-workers-${index}`} className="worker-list" hidden={!open}>{group.workers.map(card)}</div>
      </section>;
    }) : <div className="worker-list">{workers.map(card)}</div>}
  </>;
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
    if (!known.length) return "—";
    const value = known.reduce((sum, number) => sum + number, 0).toLocaleString();
    return `${value}${known.length < usage.length ? " + ?" : ""}`;
  }
  return <section className="usage" aria-label="Worker 用量"><div><small>输入 Token</small><strong>{total("inputTokens")}</strong></div><div><small>输出 Token</small><strong>{total("outputTokens")}</strong></div><div><small>缓存读取</small><strong>{total("cacheReadTokens")}</strong></div><p>{!available ? "用量服务不可用" : usage.length ? `${usage.length} 条 Worker 用量记录 · ${usage.some(record => record.attribution === "session_level") ? "含会话级数据" : "按运行时上报"}` : "尚未上报用量，未知值保留为空"}</p></section>;
}

createRoot(document.getElementById("root")!).render(<App />);
