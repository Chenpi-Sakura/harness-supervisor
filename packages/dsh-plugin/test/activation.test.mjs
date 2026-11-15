import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";

// Keep the real Cordis loader and plugin entry; replace transport and host SDK
// modules so activation cannot launch a daemon, register a host, or call a model.
const coreUrl = new URL("./fixtures/activation-core.mjs", import.meta.url).href;
const modules = new Map([
  ["@deepseek-ai/dsh-mcp-client", {
    url: "data:text/javascript,export function apply() {}",
  }],
  ["@deepseek-ai/schemastery", {
    url: "data:text/javascript," + encodeURIComponent(`
      const schema = new Proxy({}, { get: (_, key) => key === "~standard"
        ? { validate: value => ({ value }) } : key === "then" ? undefined : () => schema });
      export default schema;
    `),
  }],
  ["harness-supervisor", {
    url: coreUrl,
    source: `
      export const calls = [];
      export class SupervisorClient {
        async request(method, params) {
          calls.push({ method, params });
          if (method === "info") return { version: "0.14.0", capabilities: {
            ownerScope: true, webUi: true, managedRuntime: true, drain: true,
          } };
          return {};
        }
        close() { calls.push({ method: "close" }); }
      }
      export async function prepareRetainedRuntime(_, root) {
        return { runtime: { id: "test-core", version: "0.14.0", root },
          release() { calls.push({ method: "release" }); } };
      }
      export async function registerDshHost() { calls.push({ method: "register-host" }); }
      export async function claimIndependentState() { throw new Error("Unexpected independent instance"); }
    `,
  }],
]);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const mock = modules.get(specifier) ?? [...modules.values()].find(module => module.url === specifier);
    return mock ? { url: mock.url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    const mock = [...modules.values()].find(module => module.url === url && module.source);
    return mock ? { format: "module", source: mock.source, shortCircuit: true } : next(url, context);
  },
});
let plugin, core;
try {
  plugin = await import("../src/index.js");
  core = await import(coreUrl);
} finally { hooks.deregister(); }

const tick = () => new Promise(resolve => setImmediate(resolve));
const config = () => ({
  coreSource: { get: () => "bundled" }, corePath: { get: () => "" },
  nodeExecutable: process.execPath, stateDir: path.join(os.tmpdir(), "hs-plugin-activation-test"),
});
function host(withTitles) {
  const ctx = new Context(), routes = new Set();
  const agent = { id: "master", ctx, status: "running", session: {
    id: "master", header: { cwd: os.tmpdir() },
  } };
  ctx.provide("agents", { list: () => [agent], get: id => id === agent.id ? agent : undefined });
  ctx.provide("connection", { fetch: { register(route) {
    routes.add(route); return () => routes.delete(route);
  } } });
  if (withTitles) ctx.provide("sessionTitle", { get: () => ({ title: "Native conversation" }) });
  return { ctx, routes };
}

for (const withTitles of [false, true]) {
  test(`real Cordis activates the plugin ${withTitles ? "with" : "without"} sessionTitle`, async t => {
    core.calls.length = 0;
    const { ctx, routes } = host(withTitles);
    ctx.provide("webServer", {});
    const fiber = ctx.plugin(plugin, config());
    t.after(() => fiber.dispose());
    await tick();
    await fiber;
    assert.equal(fiber.state, 2, "Plugin must activate with the services provided by DSH");
    assert.equal(routes.size, 4);
    const contexts = core.calls.filter(call => call.method === "ui_context" && call.params.context);
    assert.ok(contexts.length > 0, "Activation must publish live Master context");
    assert.equal(contexts.at(-1).params.context.title, withTitles ? "Native conversation" : undefined);
    await fiber.dispose();
    assert.equal(routes.size, 0, "Unloading must remove all registered routes");
    assert.ok(core.calls.some(call => call.method === "release"));
  });
}

test("real Cordis waits for a required service, then activates without a title service", async t => {
  core.calls.length = 0;
  const { ctx, routes } = host(false);
  const fiber = ctx.plugin(plugin, config());
  t.after(() => fiber.dispose());
  await tick();
  assert.equal(fiber.state, 0);
  assert.equal(routes.size, 0);
  assert.equal(core.calls.length, 0);
  ctx.provide("webServer", {});
  await tick();
  await fiber;
  assert.equal(fiber.state, 2, "Only the real required service should gate activation");
  assert.equal(routes.size, 4);
});
