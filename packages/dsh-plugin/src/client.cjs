const React = require("react");
const h = React.createElement;
const PREFIX = "harness-supervisor/";

exports.inject = ["connection", "slots", "sidebarRight", "commandUi", "uiSession"];

exports.apply = function apply(ctx) {
  let disposed = false;
  const panelKey = `dsh-main-${crypto.randomUUID()}`;
  const viewGenerations = new Map();
  const controllers = new Set();
  const call = async (method, payload = {}, abort = new AbortController()) => {
    if (disposed) throw new Error("HS 插件已关闭");
    controllers.add(abort);
    try {
      const reply = await ctx.connection.rpc.call("/api", PREFIX + method, payload, abort.signal);
      if (!reply.ok) throw new Error(reply.error.message);
      return reply.value;
    } finally { controllers.delete(abort); }
  };
  const entryUrl = async (sessionId, abort, viewKey) => {
    const applicationOrigin = window.location.protocol === "dsh-app:" && window.location.host === "app"
      ? "dsh-app://app" : window.location.origin;
    const viewGeneration = viewKey ? (viewGenerations.get(viewKey) ?? 0) + 1 : undefined;
    if (viewKey) viewGenerations.set(viewKey, viewGeneration);
    const entry = await call("open-ui", { ...(sessionId ? { sessionId } : {}), applicationOrigin, ...(viewKey ? { viewKey, viewGeneration } : {}) }, abort);
    const url = new URL(entry.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) throw new Error("HS 未返回本机界面地址");
    return entry.url;
  };
  const open = async (sessionId) => {
    const url = await entryUrl(sessionId);
    if (!disposed) ctx.sidebarRight.openTab("browser", { params: { url } });
  };
  ctx.effect(() => () => {
    disposed = true;
    for (const abort of controllers) abort.abort();
    controllers.clear();
    viewGenerations.clear();
  }, "HS UI requests");

  ctx.effect(() => ctx.commandUi.register({
    name: "hs", label: () => "Harness Supervisor", description: () => "打开全局 Worker 面板，默认展开当前对话",
    available: (session) => typeof session?.sessionId === "string",
    ui: { kind: "action", run: (session) => {
      // The action consumes the UI token without submitting a model message.
      void open(session?.sessionId).catch((error) => window.alert(error.message));
    } },
  }), "HS open command");

  function SessionView({ sessionId, conversationLayout = false, surface = "sidebar" }) {
    const [url, setUrl] = React.useState("");
    const [error, setError] = React.useState("");
    React.useEffect(() => {
      let active = true;
      const abort = new AbortController();
      setUrl(""); setError("");
      void entryUrl(sessionId, abort, `${panelKey}:${surface}`).then(
        (next) => { if (active && !disposed) setUrl(next); },
        (failure) => { if (active && !disposed) setError(failure.message); },
      );
      return () => { active = false; abort.abort(); };
    }, [sessionId, surface]);
    // Follow DSH's full-height Trajectory view contract and leave room for its
    // floating composer, whose measured height is supplied by the host.
    return h("section", { ...(conversationLayout ? { "data-conversation-composer-overlay": "" } : {}), style: {
      display: "flex", flexDirection: "column", height: "100%", minHeight: 0,
      boxSizing: "border-box", overflow: "hidden", ...(conversationLayout ? { paddingBottom: "calc(var(--dsh-composer-height, 152px) + 16px)" } : {}),
    } },
      error ? h("div", { role: "alert", style: { padding: 24, overflowWrap: "anywhere" } }, "无法打开 HS 面板：", error)
        : url ? h("iframe", { key: url, src: url, title: "Harness Supervisor · 全局 Worker", sandbox: "allow-scripts allow-same-origin", referrerPolicy: "no-referrer",
          style: { flex: 1, width: "100%", minHeight: 0, border: 0 } })
          : h("p", { role: "status", style: { padding: 24 } }, "正在连接全局 Worker 面板…"));
  }
  // A keyed boundary resets the preferred conversation before a new frame mounts.
  function WorkerView({ sessionId }) { return h(SessionView, { key: sessionId ?? "global", sessionId, conversationLayout: true, surface: "conversation" }); }
  ctx.effect(() => ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view", id: "harness-supervisor", order: 30, label: () => "Harness Supervisor",
  }, WorkerView)), "HS conversation view");

  function Introduction() {
    return h("header", null,
      h("h2", null, "Harness Supervisor"),
      h("p", null, "本地、轻量、运行时无关的 Agent Worker 生命周期与通信层。让 DSH 委派和管理 Pi、Qoder、MiniMax Code 等原生 Worker。"),
      h("p", { style: { display: "flex", gap: 16 } },
        h("a", { href: "https://gitcode.com/chenpi_1/harness-supervisor", target: "_blank", rel: "noopener noreferrer" }, "项目仓库"),
        h("a", { href: "https://gitcode.com/chenpi_1/harness-supervisor/blob/main/README.md", target: "_blank", rel: "noopener noreferrer" }, "完整 README")));
  }
  function MainView() {
    const binding = React.useSyncExternalStore(ctx.uiSession.current.subscribe, ctx.uiSession.current.getSnapshot);
    // The actual current session determines only the initially expanded group.
    return h(SessionView, { key: binding.key ?? "global", sessionId: binding.key });
  }
  function SidebarIcon({ size = 16 }) {
    return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("path", { d: "M3 5v14M9 5v14M3 12h6M21 7c-1-1-2-2-4-2s-4 1-4 3.5S15 12 17 12s4 1 4 3.5-2 3.5-4 3.5-3-1-4-2" }));
  }
  ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register({
    name: "main", key: "harness-supervisor",
  }, MainView)), "HS main panel");
  ctx.effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist", id: "harness-supervisor", order: 20, label: () => "Harness Supervisor",
  }, SidebarIcon)), "HS sidebar entry");

  function Settings() {
    const [data, setData] = React.useState();
    const [error, setError] = React.useState("");
    const [notice, setNotice] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const binding = React.useSyncExternalStore(ctx.uiSession.current.subscribe, ctx.uiSession.current.getSnapshot);
    const sessionId = binding.key;
    const active = React.useRef(true);
    React.useEffect(() => {
      active.current = true;
      return () => { active.current = false; };
    }, []);
    const run = async (work) => {
      if (busy) return;
      setBusy(true); setError(""); setNotice("");
      try { await work(); }
      catch (failure) { if (active.current) setError(failure.message); }
      finally { if (active.current) setBusy(false); }
    };
    const refresh = async () => { const next = await call("status"); if (active.current) setData(next); };
    React.useEffect(() => { void run(refresh); }, []);
    const intent = data?.update?.intent;
    const draining = intent?.phase === "draining";
    const phaseText = {
      draining: "正在等待已有任务结束", switching: "正在切换配套核心", verifying: "正在验证新核心",
      complete: "配套核心已应用", cancelled: "此次更新已取消", failed: "更新未完成，请查看诊断详情",
      recovery_required: "需要人工恢复，请查看诊断详情",
    }[intent?.phase] || (data?.update?.managed ? "核心已由 HS 托管" : "当前实例尚未托管");
    const remaining = data?.update?.drain?.workerIds?.length || 0;
    const button = (label, onClick, disabled = false) => h("button", {
      type: "button", disabled: busy || disabled, onClick: () => void run(onClick),
      style: { border: "1px solid var(--dsw-alias-border-l2, #8886)", borderRadius: 7, padding: "7px 12px", color: "inherit", background: "var(--dsw-alias-bg-layer-1, transparent)", cursor: "pointer" },
    }, label);
    return h("section", { style: { padding: 20, width: "100%", lineHeight: 1.6 } },
      h("div", { style: { maxWidth: 780 } }, h(Introduction),
        h("p", null, "人工面板可查看全部 Worker，默认展开当前对话分组；没有当前对话时也可查看。")),
      h("div", { style: { width: "100%", height: "70vh", minHeight: 520, margin: "20px 0 28px" } },
        h(SessionView, { key: sessionId ?? "global", sessionId, surface: "settings" })),
      h("section", { style: { maxWidth: 780 } },
      h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        button("在右侧栏打开全局面板", () => open(sessionId), !sessionId),
        button("刷新状态", refresh)),
      h("h3", null, "配套 HS 核心"),
      h("p", null, `插件 ${data?.pluginVersion || "0.1.3"} · 配套核心 ${data?.pairedCoreVersion || "0.10.3"} · 运行核心 ${data?.supervisor?.version || "正在读取"}`),
      h("p", null, "等待已有任务结束后切换，期间仍可审批和取消任务。"),
      h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        button("应用配套 HS 核心", async () => { const result = await call("apply-core"); if (active.current) setNotice(result.alreadyActive ? "当前已是配套 HS 核心。" : "已登记更新；排空完成后由 HS 自动切换。"); await refresh(); }, draining || ["switching", "verifying"].includes(intent?.phase)),
        draining && button("取消此次更新", async () => { await call("cancel-update", { intentId: intent.id }); await refresh(); if (active.current) setNotice("已取消此次更新。"); })),
      notice && h("p", { role: "status" }, notice),
      error && h("p", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary, #c33)", overflowWrap: "anywhere" } }, error),
      data?.update && h("p", { role: "status" }, phaseText, draining ? `，剩余 ${remaining} 个 Worker。` : "。"),
      data && h("details", null, h("summary", null, "诊断详情"), h("pre", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 } }, JSON.stringify({ update: data.update, sessions: data.sessions }, null, 2))),
      h("p", { style: { fontSize: 12, opacity: 0.75 } }, "顶部标签、左侧导航、设置页和 /hs 均为人工全局视图，默认展开当前对话分组。核心重启后重新打开面板。")));
  }
  ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section", id: "harness-supervisor", order: 80,
    label: () => "Harness Supervisor",
  }, Settings)), "HS settings section");
};
