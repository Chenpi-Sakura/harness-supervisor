const React = require("react");
const h = React.createElement;
const PREFIX = "harness-supervisor/";

exports.inject = ["connection", "slots", "sidebarRight", "commandUi", "uiSession", "configForms"];

exports.apply = function apply(ctx) {
  let disposed = false;
  const panelKey = `dsh-main-${crypto.randomUUID()}`;
  const viewGenerations = new Map();
  const controllers = new Set();
  // DSH controllers expose prototype methods that require their receiver.
  const subscribeCurrent = listener => ctx.uiSession.current.subscribe(listener);
  const currentSnapshot = () => ctx.uiSession.current.getSnapshot();
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
    const binding = React.useSyncExternalStore(subscribeCurrent, currentSnapshot, currentSnapshot);
    // The actual current session determines only the initially expanded group.
    return h(SessionView, { key: binding.key ?? "global", sessionId: binding.key });
  }
  function SidebarIcon({ size = 16 }) {
    return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      h("path", { d: "M3 5v14M9 5v14M3 12h6M21 7c-1-1-2-2-4-2s-4 1-4 3.5S15 12 17 12s4 1 4 3.5-2 3.5-4 3.5-3-1-4-2" }));
  }
  ctx.effect(() => {
    const tabs = ctx.get?.("sidebarRightTabs");
    if (!tabs || typeof tabs.register !== "function") {
      console.warn("[harness-supervisor] 右侧栏不可用：没有 sidebarRightTabs 服务，右侧栏入口未注册");
      return;
    }
    // The pane slot is scoped to this effect; only the tab type needs manual disposal.
    ctx.slots.inject("sidebar.right.pane.tab", function* () {
      yield ctx.slots.register({ name: "sidebar.right.pane.tab", key: "harness-supervisor", order: 100 }, MainView);
    });
    return tabs.register({
      id: "harness-supervisor", kind: "harness-supervisor", priority: "extension",
      title: () => "Harness Supervisor",
      guide: [{
        id: "harness-supervisor", order: 450, title: () => "Harness Supervisor",
        description: () => "全局 Worker 面板，默认展开当前对话",
        icon: SidebarIcon,
      }],
    });
  }, "HS right sidebar entry");

  function Settings() {
    const form = React.useMemo(() => ctx.configForms.get("harness-supervisor"), []);
    const store = React.useMemo(() => ({ subscribe: listener => form.subscribe(listener), getSnapshot: () => form.getSnapshot() }), [form]);
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const [draft, setDraft] = React.useState(null);
    const [data, setData] = React.useState();
    const [error, setError] = React.useState("");
    const [notice, setNotice] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const active = React.useRef(true);
    React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    const run = async work => {
      if (busy) return;
      setBusy(true); setError(""); setNotice("");
      try { await work(); } catch (failure) { if (active.current) setError(failure.message); }
      finally { if (active.current) setBusy(false); }
    };
    const refresh = async () => { const next = await call("status"); if (active.current) setData(next); };
    const value = draft?.value ?? snapshot.value ?? { coreSource: "bundled", corePath: "" };
    const edit = (key, selected) => setDraft(previous => ({
      revision: previous?.revision ?? snapshot.revision,
      value: { ...(previous?.value ?? snapshot.value ?? value), [key]: selected },
    }));
    const disabled = busy || snapshot.status !== "ready" || !snapshot.writable;
    const inputStyle = { boxSizing: "border-box", width: "100%", border: "1px solid var(--dsw-alias-border-l2, #8886)", borderRadius: 8, padding: "9px 12px", color: "inherit", background: "var(--dsw-alias-bg-layer-1, #222)", font: "inherit" };
    const button = (text, action, unavailable = false) => h("button", { type: "button", disabled: busy || unavailable,
      onClick: () => void run(action), style: { ...inputStyle, width: "auto", cursor: "pointer" } }, text);
    return h("section", { style: { padding: 24, boxSizing: "border-box", width: "100%", maxWidth: 780, lineHeight: 1.6 } },
      h("h2", { style: { marginTop: 0 } }, "HS 核心来源"),
      h("label", { htmlFor: "hs-core-source", style: { display: "block", marginBottom: 8 } }, "使用哪个 HS 核心"),
      h("select", { id: "hs-core-source", value: value.coreSource, disabled, style: inputStyle, onChange: event => edit("coreSource", event.target.value) },
        h("option", { value: "bundled" }, "插件内置 HS"), h("option", { value: "npm" }, "全局 npm 安装的 HS"), h("option", { value: "custom" }, "自定义安装目录")),
      h("p", { style: { opacity: .7, fontSize: 13 } }, value.coreSource === "npm" ? "自动查找 npm install -g harness-supervisor 的安装位置。" : value.coreSource === "custom" ? "选择包含 package.json 和已构建 dist/ 的 HS 安装目录。" : "使用插件携带的 HS。插件更新后等待已有任务结束，再应用配套核心；无需额外安装。"),
      value.coreSource === "custom" && h("div", { style: { margin: "16px 0" } },
        h("label", { htmlFor: "hs-core-path", style: { display: "block", marginBottom: 8 } }, "HS 安装目录"),
        h("input", { id: "hs-core-path", value: value.corePath || "", disabled, style: inputStyle, placeholder: "HS 安装目录的绝对路径", onChange: event => edit("corePath", event.target.value) })),
      h("div", { style: { display: "flex", gap: 10, margin: "20px 0", flexWrap: "wrap" } },
        button("保存", async () => {
          if (!draft) return;
          if (value.coreSource === "custom" && !value.corePath?.trim()) throw new Error("请填写自定义 HS 安装目录");
          const accepted = await form.mutate([
            { op: "set", path: ["coreSource"], value: value.coreSource },
            { op: "set", path: ["corePath"], value: value.corePath || "" },
          ], draft.revision);
          if (!accepted) {
            if (active.current) setDraft(previous => previous && ({ ...previous, revision: form.getSnapshot().revision }));
            throw new Error("保存未被接受，草稿已保留。配置可能已被其他窗口修改，请核对后再次保存。");
          }
          if (active.current) { setDraft(null); setNotice("来源已保存。正在连接所选 HS；可刷新状态确认，原有 Worker 不会停止。"); }
        }, disabled || !draft),
        button("刷新状态", refresh)),
      snapshot.status === "unavailable" && h("p", { role: "alert" }, "宿主尚未提供 HS 配置表单，请确认已更新插件并重新启用。"),
      notice && h("p", { role: "status" }, notice),
      data?.supervisor && h("p", null, `运行 HS v${data.supervisor.version} · 配套 HS v${data.pairedCoreVersion}`),
      data?.update?.intent && ["draining", "switching", "verifying"].includes(data.update.intent.phase) && h("p", { role: "status" }, "配套核心正在受控升级；已有任务会继续，完成后重新打开 Worker 面板。"),
      error && h("p", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary, #d66)", overflowWrap: "anywhere" } }, error),
      h("details", { style: { marginTop: 24 } }, h("summary", { style: { cursor: "pointer" } }, "诊断详情"),
        h("pre", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 } }, JSON.stringify(data ?? { state: "尚未读取运行状态" }, null, 2))));
  }

  ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section", id: "harness-supervisor", order: 80,
    label: () => "Harness Supervisor",
  }, Settings)), "HS settings section");
};
