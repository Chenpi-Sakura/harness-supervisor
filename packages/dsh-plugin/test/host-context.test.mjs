import assert from "node:assert/strict";
import test from "node:test";
import { createMasterPublisher, masterSnapshot, sessionCwd } from "../src/host-context.js";

test("DSH context uses public session cwd and keeps selected and requested models distinct", () => {
  let selection = { provider: "selected-provider", model: "selected", reasoningEffort: "high", apiKey: "secret" };
  const agent = { id: "a", status: "running", model: { current: () => selection }, session: {
    id: "a", header: { cwd: "/real/project" }, meta: { cwd: "/old/project" },
    requestHeader: () => ({ config: { provider: "actual-provider", model: "requested", reasoningEffort: "low", apiKey: "secret" } }),
  } };
  const titles = { get: () => ({ title: "Current conversation" }), ensure() { throw Error("must never generate a title"); } };
  const context = masterSnapshot(agent, "profile", titles);
  assert.equal(context.cwd, "/real/project"); assert.equal(context.title, "Current conversation");
  assert.equal(context.harness, "dsh"); assert.equal(context.status, "running");
  assert.deepEqual(context.selection, { provider: "selected-provider", model: "selected", reasoningEffort: "high" });
  assert.equal(context.lastRequest.model, "requested"); assert.ok(!JSON.stringify(context).includes("secret"));
  selection = { model: "different-model" };
  assert.equal(masterSnapshot(agent, "profile").selection.reasoningEffort, undefined);
  assert.equal(sessionCwd({ meta: { cwd: "/legacy/project" } }), "/legacy/project");
  assert.equal(sessionCwd({}), undefined);
});

test("Master updates require an exact live Agent and old disposal cannot erase its replacement", async () => {
  const session = { id: "a", header: { cwd: "/project" } };
  const old = { id: "a", session, status: "running" }, replacement = { ...old, session: { ...session }, status: "idle" };
  const live = new Map([["a", old]]), calls = [];
  const publisher = createMasterPublisher({ namespace: "p", agents: { get: id => live.get(id) }, request: async (method, params) => calls.push({ method, params }) });
  await publisher.update(old); assert.equal(calls.length, 1);
  live.set("a", replacement);
  await publisher.update(old); assert.equal(calls.length, 1);
  await publisher.update(replacement);
  await publisher.remove(old); assert.equal(calls.length, 2);
  publisher.sessionEvent(old.session, { type: "request/header" });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 2);
  publisher.sessionEvent(replacement.session, { type: "model/selection" });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 3);
  assert.equal(calls[2].params.context.status, "idle");
  await publisher.dispose(); assert.equal(calls.at(-1).params.remove, true);
  await publisher.update(replacement); assert.equal(calls.length, 4);
});

test("concurrent host reports serialize connection and disposal drains an in-flight update before removing it", async () => {
  const agents = ["a", "b"].map(id => ({ id, session: { id }, status: "running" }));
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const stored = new Map(), calls = [];
  let concurrent = 0, maximum = 0;
  const publisher = createMasterPublisher({ namespace: "p", agents: { get: id => agents.find(agent => agent.id === id) }, request: async (_, params) => {
    concurrent++; maximum = Math.max(maximum, concurrent); calls.push(params);
    if (calls.length === 1) await blocked;
    if (params.remove) stored.delete(params.ownerRef); else stored.set(params.context.ownerRef, params.context);
    concurrent--;
  } });
  const updating = Promise.all(agents.map(agent => publisher.update(agent)));
  let disposed = false;
  const disposal = publisher.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(disposed, false);
  release(); await Promise.all([updating, disposal]);
  assert.equal(maximum, 1); assert.equal(stored.size, 0);
  assert.deepEqual(calls.map(call => Boolean(call.remove)), [false, false, true, true]);
});
