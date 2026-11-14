import { createHash } from "node:crypto";

/** Correlation scope only. It is not a same-user or operating-system sandbox. */
export function ownerRefFor(namespace, sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 300) {
    throw new Error("DSH did not supply a valid live Agent/Session identity");
  }
  return `dsh:${createHash("sha256").update(namespace).update("\0").update(sessionId).digest("hex")}`;
}

/** Own native MCP fibers by exact Agent object, including in-flight activation. */
export class AgentBridge {
  #entries = new Map();
  #closing = false;
  constructor({ namespace, attach, report = () => {} }) {
    this.namespace = namespace;
    this.attach = attach;
    this.report = report;
  }

  attachAgent(agent) {
    if (this.#closing) return Promise.resolve();
    const found = this.#entries.get(agent);
    if (found) return found.ready;
    const entry = { removed: false, fiber: undefined, ready: undefined };
    this.#entries.set(agent, entry);
    entry.ready = (async () => {
      try {
        const ownerRef = ownerRefFor(this.namespace, agent.id);
        if (agent.session?.id !== agent.id || typeof agent.ctx?.plugin !== "function") {
          throw new Error("Required DSH live Agent capabilities are unavailable");
        }
        // attach returns the Fiber synchronously; awaiting the Fiber waits for ready.
        entry.fiber = this.attach(agent, ownerRef);
        if (!entry.fiber || typeof entry.fiber.dispose !== "function") {
          throw new Error("DSH MCP registration did not return a disposable Fiber");
        }
        if (entry.removed || this.#closing) {
          await entry.fiber.dispose();
          return;
        }
        await entry.fiber;
        if (entry.removed || this.#closing) await entry.fiber.dispose();
        else this.report(agent, { state: "connected", ownerRef });
      } catch (error) {
        if (!entry.removed && !this.#closing) {
          this.report(agent, { state: "failed", message: error instanceof Error ? error.message : String(error) });
        }
        // No global fallback: a failed scope must never register global tools.
        await entry.fiber?.dispose();
      }
    })();
    return entry.ready;
  }

  async detachAgent(agent) {
    const entry = this.#entries.get(agent);
    if (!entry) return;
    entry.removed = true;
    this.#entries.delete(agent);
    await entry.fiber?.dispose();
    await entry.ready;
  }

  async dispose() {
    if (this.#closing) return;
    this.#closing = true;
    const agents = [...this.#entries.keys()];
    await Promise.allSettled(agents.map((agent) => this.detachAgent(agent)));
  }
}

export const RPC_PREFIX = "harness-supervisor/";
export const RPC_ENDPOINTS = new Set(["open-ui", "status", "apply-core", "cancel-update"]);

/**
 * Exact Fetch routes are owner-only in DSH Connection before this adapter runs.
 * Reuse the public RPC wire format without claiming the single /api interceptor.
 */
export function createFetchRoutes(handler) {
  return [...RPC_ENDPOINTS].map((method) => ({
    path: `/api/${RPC_PREFIX}${method}`, methods: ["POST"], requestBody: "buffered",
    async fetch(request) {
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return new Response("Expected application/json", { status: 415 });
      let message;
      try { message = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
      if (!message || typeof message !== "object" || Array.isArray(message)
        || Object.keys(message).some((key) => !["type", "rpcId", "method", "payload"].includes(key))
        || message.type !== "client-request" || typeof message.rpcId !== "string" || !message.rpcId || message.rpcId.length > 200
        || message.method !== `${RPC_PREFIX}${method}`) return new Response("Invalid RPC envelope", { status: 400 });
      const result = await handler(method, message.payload, request.signal, { principal: { kind: "owner" } });
      return Response.json({ type: "server-response", rpcId: message.rpcId, result });
    },
  }));
}

export function localApplicationOrigin(value) {
  if (typeof value !== "string") throw new Error("A DSH application origin is required");
  // Desktop has an opaque URL.origin. Preserve only its exact registered
  // application origin so the shared UI can be framed in a conversation view.
  if (value === "dsh-app://app") return value;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.origin !== value) {
    throw new Error("HS embedding is available only in a local DSH application");
  }
  return url.origin;
}

export function createRpcHandler({ agents, namespace, request, status, applyCore, cancelUpdate }) {
  return async (endpoint, payload, signal, peer) => {
    try {
      if (peer?.principal?.kind !== "owner") throw new Error("Only the authenticated DSH owner may manage HS");
      if (signal.aborted) throw new Error("Request aborted");
      const method = endpoint;
      if (!RPC_ENDPOINTS.has(method)) throw new Error("Unknown HS endpoint");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid HS request");
      let value;
      if (method === "open-ui") {
        if (Object.keys(payload).some((key) => !["sessionId", "applicationOrigin", "viewKey", "viewGeneration"].includes(key))) throw new Error("Unexpected open-ui field");
        if (payload.viewKey !== undefined && (typeof payload.viewKey !== "string" || !payload.viewKey || payload.viewKey.length > 200)) throw new Error("Invalid panel view key");
        if (payload.viewGeneration !== undefined && (!Number.isSafeInteger(payload.viewGeneration) || payload.viewGeneration < 1 || payload.viewKey === undefined)) throw new Error("Invalid panel generation");
        let preferredOwnerRef;
        if (payload.sessionId !== undefined) {
          const agent = typeof payload.sessionId === "string" ? agents.get(payload.sessionId) : undefined;
          if (!agent || agent.session?.id !== agent.id) throw new Error("Open a live DSH session before choosing its default Worker group");
          preferredOwnerRef = ownerRefFor(namespace, agent.id);
        }
        const frameOrigin = localApplicationOrigin(payload.applicationOrigin);
        try {
          // This route is authenticated owner UI, not a model tool. Its access
          // is global; the live session is only a default expansion preference.
          value = await request("ui_start", { ...(preferredOwnerRef === undefined ? {} : { preferredOwnerRef }), frameOrigin, ...(payload.viewKey === undefined ? {} : { viewKey: payload.viewKey }), ...(payload.viewGeneration === undefined ? {} : { viewGeneration: payload.viewGeneration }) });
        } catch (error) {
          if (["BAD_REQUEST", "UNSUPPORTED"].includes(error?.code)) {
            throw new Error("当前运行的 HS 核心尚不支持顶部面板。请在设置 → Harness Supervisor → 应用配套 HS 核心后，重新打开标签页。");
          }
          throw error;
        }
      } else if (method === "status") {
        if (Object.keys(payload).length) throw new Error("Unexpected status field");
        value = await status();
      } else if (method === "apply-core") {
        if (Object.keys(payload).length) throw new Error("The paired core version is fixed by the plugin");
        value = await applyCore();
      } else {
        if (Object.keys(payload).some((key) => key !== "intentId") || typeof payload.intentId !== "string" || !payload.intentId || payload.intentId.length > 200) {
          throw new Error("A current update intentId is required");
        }
        value = await cancelUpdate(payload.intentId);
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: { code: "harness-supervisor/request-refused", message: error instanceof Error ? error.message : String(error), details: {} } };
    }
  };
}
