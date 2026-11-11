const React = require("react");
const h = React.createElement;
const PREFIX = "harness-supervisor/";

exports.inject = ["connection", "slots", "sidebarRight", "commandUi", "uiSession"];

exports.apply = function apply(ctx) {
  let disposed = false;
  const controllers = new Set();
  const call = async (method, payload = {}) => {
    if (disposed) throw new Error("HS 插件已关闭");
    const abort = new AbortController();
    controllers.add(abort);
    try {
      const reply = await ctx.connection.rpc.call("/api", PREFIX + method, payload, abort.signal);
      if (!reply.ok) throw new Error(reply.error.message);
      return reply.value;
    } finally { controllers.delete(abort); }
  };
  const open = async (sessionId) => {
    const applicationOrigin = window.location.protocol === "dsh-app:" && window.location.host === "app"
      ? "dsh-app://app" : window.location.origin;
    const entry = await call("open-ui", { sessionId, applicationOrigin });
    if (disposed) return;
    const url = new URL(entry.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("HS 未返回本机界面地址");
    ctx.sidebarRight.openTab("browser", { params: { url: entry.url } });
  };
  ctx.effect(() => () => {
    disposed = true;
    for (const abort of controllers) abort.abort();
    controllers.clear();
  }, "HS UI requests");

  ctx.effect(() => ctx.commandUi.register({
    name: "hs", label: () => "Harness Supervisor", description: () => "打开当前会话的 Worker 面板",
    available: (session) => typeof session.sessionId === "string",
    ui: { kind: "action", run: (session) => {
      // The action consumes the UI token without submitting a model message.
      void open(session.sessionId).catch((error) => window.alert(error.message));
    } },
  }), "HS open command");

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
    return h("section", { style: { padding: 20, maxWidth: 780, lineHeight: 1.6 } },
      h("h2", null, "Harness Supervisor"),
      h("p", null, "当前 DSH 会话可委派原生 Worker。面板展示任务与审批，模型通过 HS 工具读取结果。"),
      h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        button("打开当前会话面板", () => open(sessionId), !sessionId),
        button("刷新状态", refresh)),
      !sessionId && h("p", null, "请先打开一个 DSH 会话。"),
      h("h3", null, "配套 HS 核心"),
      h("p", null, `插件 ${data?.pluginVersion || "0.1.0"} · 配套核心 ${data?.pairedCoreVersion || "0.10.0"} · 运行核心 ${data?.supervisor?.version || "正在读取"}`),
      h("p", null, "应用版本会暂停共享 daemon 的新任务准入，等待已有任务与队列结束后切换。审批和取消任务仍然可用；插件关闭后更新仍由 HS 继续。"),
      h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        button("应用配套 HS 核心", async () => { const result = await call("apply-core"); if (active.current) setNotice(result.alreadyActive ? "当前已是配套 HS 核心。" : "已登记更新；排空完成后由 HS 自动切换。"); await refresh(); }, draining || ["switching", "verifying"].includes(intent?.phase)),
        draining && button("取消此次更新", async () => { await call("cancel-update", { intentId: intent.id }); await refresh(); if (active.current) setNotice("已取消此次更新。"); })),
      notice && h("p", { role: "status" }, notice),
      error && h("p", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary, #c33)", overflowWrap: "anywhere" } }, error),
      data?.update && h("p", { role: "status" }, phaseText, draining ? `，剩余 ${remaining} 个 Worker。` : "。"),
      data && h("details", null, h("summary", null, "诊断详情"), h("pre", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 } }, JSON.stringify({ update: data.update, sessions: data.sessions }, null, 2))),
      h("p", { style: { fontSize: 12, opacity: 0.75 } }, "范围固定于打开面板时的会话。切换 DSH 会话后，请重新打开对应面板。daemon 重启后需重新连接。"));
  }
  ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section", id: "harness-supervisor", order: 80,
    label: () => "Harness Supervisor",
  }, Settings)), "HS settings section");
};
