import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import z from "@deepseek-ai/schemastery";
import { SupervisorClient, prepareManagedRuntime } from "harness-supervisor";
import { AgentBridge, createRpcHandler, createFetchRoutes } from "./bridge.js";
import { resolveNodeExecutable } from "./node-runtime.js";
import { resolvePluginState } from "./state-dir.js";
import { findGlobalCore, validateCoreRoot } from "./core-source.js";
import { createSourceBinding } from "./source-binding.js";

export const name = "harness-supervisor";
export const inject = ["agents", "connection", "webServer"];
export const Config = z.object({
  coreSource: z.union([z.const("bundled").description("插件内置 HS"), z.const("npm").description("全局 npm 安装的 HS"), z.const("custom").description("自定义安装目录")]).default("bundled").description("HS 核心来源").volatile(),
  corePath: z.string().default("").description("自定义 HS 安装目录（仅自定义模式需要）").volatile(),
  stateDir: z.string().default(""),
  nodeExecutable: z.string().default(""),
});

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("harness-supervisor"))), "../..");
const EXPECTED_CORE_VERSION = "0.12.0";

export function assertCapabilities(info) {
  const required = ["ownerScope", "webUi", "managedRuntime", "drain"];
  if (!info?.capabilities || required.some((key) => info.capabilities[key] !== true)) {
    throw new Error(`The selected HS daemon (${info?.version ?? "unknown"}) lacks required capabilities. Update the selected core after its tasks have finished.`);
  }
}

export async function apply(ctx, config) {
  const state = { readStatus: undefined, error: undefined };
  const binding = createSourceBinding(snapshot => ctx.plugin(inner => mount(inner, snapshot, state), {}));
  const rebind = () => {
    const snapshot = { ...config, coreSource: config.coreSource.get(), corePath: config.corePath.get() };
    state.desired = snapshot; state.readStatus = undefined; state.error = undefined;
    return binding.update(snapshot).catch(error => {
      if (state.desired === snapshot) state.error = error.message;
      ctx.logger.warn(`HS source connection failed: ${error.message}`);
    });
  };
  ctx.effect(() => () => { state.desired = undefined; return binding.dispose(); }, "HS configured connection");
  const rpc = createRpcHandler({ status: async () => state.readStatus ? state.readStatus() : { connection: { state: state.error ? "failed" : "connecting", error: state.error }, coreSource: config.coreSource.get() } });
  for (const route of createFetchRoutes(rpc).filter(route => route.path.endsWith("/status"))) ctx.effect(() => ctx.connection.fetch.register(route), "HS stable source diagnostics");
  ctx.on("loader/volatile-update", rebind);
  await rebind();
}

async function mount(ctx, config, state) {
  if (!ctx.agents?.list || !ctx.agents?.get || !ctx.connection?.fetch?.register || typeof ctx.effect !== "function") {
    throw new Error("Required DSH Agent and Connection APIs are unavailable");
  }
  const { stateDir, namespace } = resolvePluginState(config);
  const nodeExecutable = resolveNodeExecutable(config.nodeExecutable);
  const external = config.coreSource && config.coreSource !== "bundled";
  if (![undefined, "bundled", "npm", "custom"].includes(config.coreSource)) throw new Error("未知 HS 核心来源");
  const selectedRoot = config.coreSource === "npm" ? findGlobalCore(nodeExecutable)
    : config.coreSource === "custom" ? validateCoreRoot(config.corePath) : coreRoot;
  // Stage before auto-start: plugin removal must not remove a live daemon's code.
  // The selected install is copied before use; npm updates cannot remove live code.
  const selectedRuntime = await prepareManagedRuntime(stateDir, selectedRoot);
  if (state.desired !== config) return;
  const uiPort = external ? 61114 : 61115;
  const client = new SupervisorClient({ stateDir, daemonEntry: path.join(selectedRuntime.root, "dist/src/daemon-entry.js"), nodeExecutable, uiPort });
  const connections = new Map();
  const request = async (method, params = {}) => client.request(method, params, { timeoutMs: 120_000 });
  ctx.effect(() => () => client.close(), "HS operator IPC connection");
  // Existing instances retain their verified core until a controlled update.
  const info = await request("info");
  if (state.desired !== config) return;
  assertCapabilities(info);

  const bridge = new AgentBridge({
    namespace,
    attach: (agent, ownerRef) => agent.ctx.plugin(mcpClient, {
      transport: "stdio", serverName: "harness_supervisor", command: nodeExecutable,
      args: [path.join(selectedRuntime.root, "dist/src/mcp.js"), "--state-dir", stateDir, "--owner-ref", ownerRef, "--notify-none"],
      env: { HARNESS_SUPERVISOR_UI_PORT: String(uiPort) }, cwd: agent.session.meta?.cwd || process.cwd(), toolCallTimeoutMs: 150_000,
      startupTimeoutMs: 30_000, closeTimeoutMs: 5_000, expandTemplates: false, failOnStartupError: true,
    }),
    report: (agent, status) => {
      connections.set(agent, status);
      if (status.state === "failed") ctx.logger.warn(`HS session connection failed: ${status.message}`);
    },
  });
  ctx.effect(() => () => bridge.dispose(), "HS session MCP fibers");
  ctx.on("agent/created", async ({ agent }) => bridge.attachAgent(agent));
  ctx.on("agent/disposed", ({ agent }) => { connections.delete(agent); return bridge.detachAgent(agent); });
  let applying;
  const applyCore = () => applying ??= (async () => {
    if (external) throw new Error("独立 HS 请通过其自身安装方式更新，插件不会应用内置核心");
    const current = await request("runtime_update_status");
    if (current.activeRuntimeId === selectedRuntime.id && !["draining", "switching", "verifying"].includes(current.intent?.phase)) {
      return { alreadyActive: true, runtimeId: selectedRuntime.id, version: EXPECTED_CORE_VERSION };
    }
    const intentId = current.intent?.targetRuntimeId === selectedRuntime.id && ["draining", "switching", "verifying"].includes(current.intent.phase)
      ? current.intent.id : randomUUID();
    return request("runtime_update", { intentId, runtimeId: selectedRuntime.id });
  })().finally(() => { applying = undefined; });
  const status = async () => ({
      pluginVersion: "0.3.0", pairedCoreVersion: EXPECTED_CORE_VERSION, externalCore: Boolean(external), coreSource: config.coreSource || "bundled", sourceRoot: selectedRoot,
      supervisor: await request("info"), update: await request("runtime_update_status"),
      sessions: [...connections].map(([agent, status]) => ({ sessionId: agent.id, ...status })),
    });
  state.readStatus = status;
  ctx.effect(() => () => { if (state.readStatus === status) state.readStatus = undefined; }, "HS diagnostics owner");
  const rpc = createRpcHandler({
    agents: ctx.agents, namespace, request, status,
    applyCore,
    cancelUpdate: (intentId) => { if (external) throw new Error("请通过独立 HS 管理其更新"); return request("runtime_update_cancel", { intentId }); },
  });
  for (const route of createFetchRoutes(rpc).filter(route => !route.path.endsWith("/status"))) {
    ctx.effect(() => ctx.connection.fetch.register(route), `HS owner-only ${route.path}`);
  }
  await Promise.all(ctx.agents.list().map((agent) => bridge.attachAgent(agent)));
}
