import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import z from "@deepseek-ai/schemastery";
import { SupervisorClient, prepareManagedRuntime } from "harness-supervisor";
import { AgentBridge, createRpcHandler, createFetchRoutes } from "./bridge.js";
import { resolveNodeExecutable } from "./node-runtime.js";

export const name = "harness-supervisor";
export const inject = ["agents", "connection", "webServer"];
export const Config = z.object({
  stateDir: z.string().default(""),
  nodeExecutable: z.string().default(""),
});

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("harness-supervisor"))), "../..");
const EXPECTED_CORE_VERSION = "0.10.5";

export function assertCapabilities(info) {
  const required = ["ownerScope", "webUi", "managedRuntime", "drain"];
  if (!info?.capabilities || required.some((key) => info.capabilities[key] !== true)) {
    throw new Error(`The shared HS daemon (${info?.version ?? "unknown"}) lacks required capabilities. Migrate it in a maintenance window; the plugin will not replace it or use global model access.`);
  }
}

export async function apply(ctx, config) {
  if (!ctx.agents?.list || !ctx.agents?.get || !ctx.connection?.fetch?.register || typeof ctx.effect !== "function") {
    throw new Error("DSH 0.2.2-rc.1 Agent and Connection APIs are required");
  }
  const stateDir = path.resolve(config.stateDir || process.env.HARNESS_SUPERVISOR_HOME || path.join(os.homedir(), ".harness-supervisor"));
  const namespace = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
  const nodeExecutable = resolveNodeExecutable(config.nodeExecutable);
  // Stage before auto-start: plugin removal must not remove a live daemon's code.
  // An existing daemon still wins its normal lock and is checked, never replaced.
  const bundledRuntime = await prepareManagedRuntime(stateDir, coreRoot);
  const client = new SupervisorClient({ stateDir, daemonEntry: path.join(bundledRuntime.root, "dist/src/daemon-entry.js"), nodeExecutable });
  const connections = new Map();
  const request = async (method, params = {}) => client.request(method, params, { timeoutMs: 120_000 });
  ctx.effect(() => () => client.close(), "HS operator IPC connection");
  // The daemon's own managed resolver selects the active core. No host install is changed.
  const info = await request("info");
  assertCapabilities(info);

  const bridge = new AgentBridge({
    namespace,
    attach: (agent, ownerRef) => agent.ctx.plugin(mcpClient, {
      transport: "stdio", serverName: "harness_supervisor", command: nodeExecutable,
      args: [path.join(bundledRuntime.root, "dist/src/mcp.js"), "--state-dir", stateDir, "--owner-ref", ownerRef, "--notify-none"],
      env: {}, cwd: agent.session.meta?.cwd || process.cwd(), toolCallTimeoutMs: 150_000,
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
    const current = await request("runtime_update_status");
    if (current.activeRuntimeId === bundledRuntime.id && !["draining", "switching", "verifying"].includes(current.intent?.phase)) {
      return { alreadyActive: true, runtimeId: bundledRuntime.id, version: EXPECTED_CORE_VERSION };
    }
    const intentId = current.intent?.targetRuntimeId === bundledRuntime.id && ["draining", "switching", "verifying"].includes(current.intent.phase)
      ? current.intent.id : randomUUID();
    return request("runtime_update", { intentId, runtimeId: bundledRuntime.id });
  })().finally(() => { applying = undefined; });
  const rpc = createRpcHandler({
    agents: ctx.agents, namespace, request,
    status: async () => ({
      pluginVersion: "0.1.5", pairedCoreVersion: EXPECTED_CORE_VERSION,
      supervisor: await request("info"), update: await request("runtime_update_status"),
      sessions: [...connections].map(([agent, status]) => ({ sessionId: agent.id, ...status })),
    }),
    applyCore,
    cancelUpdate: (intentId) => request("runtime_update_cancel", { intentId }),
  });
  for (const route of createFetchRoutes(rpc)) {
    ctx.effect(() => ctx.connection.fetch.register(route), `HS owner-only ${route.path}`);
  }
  await Promise.all(ctx.agents.list().map((agent) => bridge.attachAgent(agent)));
}
