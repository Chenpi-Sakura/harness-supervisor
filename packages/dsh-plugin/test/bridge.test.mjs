import assert from "node:assert/strict";
import test from "node:test";
import { AgentBridge, createFetchRoutes, createRpcHandler, localApplicationOrigin, ownerRefFor } from "../src/bridge.js";

function agent(id) { return { id, session: { id }, ctx: { plugin() {} } }; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fiber(ready = Promise.resolve()) {
  return { disposals: 0, then: ready.then.bind(ready), async dispose() { this.disposals++; } };
}

test("one native MCP connection per Agent lifetime; reused session ids do not share a disposable", async () => {
  const first = agent("session-a"), other = agent("session-b"), replacement = agent("session-a");
  const made = [];
  const bridge = new AgentBridge({ namespace: "profile", attach: (subject, owner) => {
    const handle = fiber(); made.push({ subject, owner, handle }); return handle;
  } });
  await Promise.all([bridge.attachAgent(first), bridge.attachAgent(first), bridge.attachAgent(other)]);
  assert.equal(made.length, 2);
  assert.notEqual(made[0].owner, made[1].owner);
  await bridge.attachAgent(replacement);
  await bridge.detachAgent(first);
  assert.equal(made[2].handle.disposals, 0, "old disposal must not close the same-id replacement");
  assert.equal(made[0].owner, made[2].owner, "native session owner remains stable across activation");
  await bridge.dispose();
  assert.ok(made.every((item) => item.handle.disposals > 0));
  await bridge.attachAgent(agent("late"));
  assert.equal(made.length, 3, "unloaded plugin cannot reopen transports");
});

test("plugin unload waits for an in-flight native MCP attachment and releases it", async () => {
  const ready = deferred(), handle = fiber(ready.promise), statuses = [];
  const bridge = new AgentBridge({ namespace: "p", attach: () => handle, report: (_, status) => statuses.push(status) });
  const attaching = bridge.attachAgent(agent("a"));
  const disposing = bridge.dispose();
  ready.resolve();
  await Promise.all([attaching, disposing]);
  assert.ok(handle.disposals > 0);
  assert.deepEqual(statuses, []);
});

test("failure does not fall back to global tool registration", async () => {
  const statuses = [], ready = deferred(), handle = fiber(ready.promise);
  const bridge = new AgentBridge({ namespace: "p", attach: () => handle, report: (_, status) => statuses.push(status) });
  const attaching = bridge.attachAgent(agent("a"));
  ready.reject(new Error("isolated MCP failed"));
  await attaching;
  assert.equal(statuses[0].state, "failed");
  assert.equal(handle.disposals, 1);
  await bridge.dispose();
});

test("correlation scopes separate DSH homes without disclosing local paths", () => {
  const value = ownerRefFor("C:/Users/private/.dsh", "abc");
  assert.match(value, /^dsh:[a-f0-9]{64}$/);
  assert.notEqual(value, ownerRefFor("other", "abc"));
  assert.throws(() => ownerRefFor("p", ""));
});

test("Host RPC gives only the human owner a global view and derives its preferred group from a live Agent", async () => {
  const current = agent("session-a"), calls = [];
  const handler = createRpcHandler({ agents: { get: (id) => id === current.id ? current : undefined }, namespace: "p",
    request: async (method, params) => { calls.push({ method, params }); return { url: "local" }; }, status: async () => ({}), applyCore: async () => ({}), cancelUpdate: async () => ({}) });
  const payload = { sessionId: "session-a", applicationOrigin: "http://127.0.0.1:3080" };
  const signal = new AbortController().signal;
  const owner = { principal: { kind: "owner" } };
  assert.equal((await handler("open-ui", payload, signal, { principal: { kind: "agent" } })).ok, false);
  assert.equal((await handler("open-ui", { ...payload, ownerRef: "victim" }, signal, owner)).ok, false);
  assert.equal((await handler("open-ui", { ...payload, sessionId: "missing" }, signal, owner)).ok, false);
  assert.equal((await handler("open-ui", { ...payload, applicationOrigin: "https://evil.example" }, signal, owner)).ok, false);
  assert.equal(calls.length, 0);
  assert.equal((await handler("open-ui", payload, signal, owner)).ok, true);
  assert.deepEqual(calls, [{ method: "ui_start", params: { preferredOwnerRef: ownerRefFor("p", current.id), frameOrigin: payload.applicationOrigin } }]);
  assert.equal((await handler("open-ui", { ...payload, applicationOrigin: "dsh-app://app" }, signal, owner)).ok, true);
  assert.deepEqual(calls[1], { method: "ui_start", params: { preferredOwnerRef: ownerRefFor("p", current.id), frameOrigin: "dsh-app://app" } });
  assert.throws(() => localApplicationOrigin("dsh-app://evil"));
  assert.throws(() => localApplicationOrigin("dsh-app://app/"));
  assert.throws(() => localApplicationOrigin("null"));
  assert.equal((await handler("open-ui", { ...payload, viewKey: "panel-one" }, signal, owner)).ok, true);
  assert.deepEqual(calls[2], { method: "ui_start", params: { preferredOwnerRef: ownerRefFor("p", current.id), frameOrigin: payload.applicationOrigin, viewKey: "panel-one" } });
  assert.equal((await handler("open-ui", { ...payload, viewKey: {} }, signal, owner)).ok, false);
  assert.equal((await handler("open-ui", { ...payload, preferredOwnerRef: "victim" }, signal, owner)).ok, false);
  assert.equal((await handler("open-ui", { applicationOrigin: payload.applicationOrigin }, signal, { principal: { kind: "agent" } })).ok, false);
  assert.equal((await handler("open-ui", { applicationOrigin: payload.applicationOrigin }, signal, owner)).ok, true);
  assert.deepEqual(calls[3], { method: "ui_start", params: { frameOrigin: payload.applicationOrigin } });
  assert.equal((await handler("open-ui", { ...payload, viewKey: "panel-one", viewGeneration: 2 }, signal, owner)).ok, true);
  assert.deepEqual(calls[4], { method: "ui_start", params: { preferredOwnerRef: ownerRefFor("p", current.id), frameOrigin: payload.applicationOrigin, viewKey: "panel-one", viewGeneration: 2 } });
  for (const viewGeneration of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"]) {
    assert.equal((await handler("open-ui", { ...payload, viewKey: "panel-one", viewGeneration }, signal, owner)).ok, false);
  }
  assert.equal((await handler("open-ui", { ...payload, viewGeneration: 1 }, signal, owner)).ok, false);
});

test("update RPC only exposes fixed paired candidate and explicit drain cancellation", async () => {
  let applied = 0; const cancelled = [];
  const handler = createRpcHandler({ agents: {}, namespace: "p", request() {}, status: async () => ({ good: true }), applyCore: async () => ({ n: ++applied }), cancelUpdate: async (id) => { cancelled.push(id); return { done: true }; } });
  const signal = new AbortController().signal, owner = { principal: { kind: "owner" } };
  assert.equal((await handler("apply-core", { sourceRoot: "attacker" }, signal, owner)).ok, false);
  assert.equal((await handler("shutdown", {}, signal, owner)).ok, false);
  assert.equal((await handler("apply-core", {}, signal, owner)).ok, true);
  assert.equal(applied, 1);
  assert.equal((await handler("cancel-update", { intentId: "intent-a" }, signal, owner)).ok, true);
  assert.deepEqual(cancelled, ["intent-a"]);
  assert.throws(() => localApplicationOrigin("http://127.0.0.1:3080/"));
  assert.throws(() => localApplicationOrigin("http://localhost.attacker:3080"));
});

test("an older compatible core reports how to enable the new conversation view", async () => {
  const current = agent("session-a");
  const handler = createRpcHandler({ agents: { get: () => current }, namespace: "p",
    request: async () => { throw Object.assign(new Error("Invalid params for method ui_start"), { code: "BAD_REQUEST" }); } });
  const reply = await handler("open-ui", { sessionId: current.id, applicationOrigin: "dsh-app://app", viewKey: "main-panel" }, new AbortController().signal, { principal: { kind: "owner" } });
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /应用配套 HS 核心/);
});

test("exact owner-only Fetch routes preserve native RPC correlation and reject mismatched methods", async () => {
  const called = [];
  const routes = createFetchRoutes(async (...args) => { called.push(args); return { ok: true, value: { managed: true } }; });
  assert.equal(routes.length, 4);
  assert.ok(routes.every((route) => route.path.startsWith("/api/harness-supervisor/")));
  const route = routes.find((entry) => entry.path.endsWith("/status"));
  const message = { type: "client-request", rpcId: "correlation", method: "harness-supervisor/status", payload: {} };
  const invoke = (value) => route.fetch(new Request("http://127.0.0.1" + route.path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }));
  const good = await invoke(message);
  assert.deepEqual(await good.json(), { type: "server-response", rpcId: "correlation", result: { ok: true, value: { managed: true } } });
  assert.equal(called[0][0], "status");
  assert.equal(called[0][3].principal.kind, "owner");
  assert.equal((await invoke({ ...message, method: "harness-supervisor/apply-core" })).status, 400);
  assert.equal((await invoke({ ...message, type: "server-response" })).status, 400);
  assert.equal((await invoke({ ...message, rpcId: "" })).status, 400);
  assert.equal((await invoke({ ...message, extra: "untrusted" })).status, 400);
  assert.equal(called.length, 1);
});
