import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { NativeAcpAdapter } from "../../src/adapters/native-acp/adapter.js";
import { resolveNativeAcpLaunch, type NativeAcpRuntime } from "../../src/adapters/native-acp/launch.js";
import { NativeAcpSession } from "../../src/adapters/native-acp/session.js";
import type { HarnessEvent, HarnessSession } from "../../src/types.js";
const fixture = fileURLToPath(new URL("../fixtures/fake-native-acp.js", import.meta.url));
async function setup(t: { after: (fn: () => Promise<void>) => void }, runtime: NativeAcpRuntime = "codex", extraEnv = {}, nativeDefaults = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-native-acp-"));
  const owned: HarnessSession[] = [];
  t.after(async () => { for (const session of owned) await session.close({ graceMs: 100 }); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const adapter = new NativeAcpAdapter(runtime, { launch: { file: process.execPath, args: [fixture], env: { ...process.env, FAKE_ACP_RUNTIME: runtime, ...extraEnv }, description: "fake ACP" }, abortTimeoutMs: 200 });
  const events: HarnessEvent[] = [];
  const callbacks = { onEvent: (event: HarnessEvent) => events.push(event), onExit: () => {} };
  const spec = { workerId: "test", cwd: dir, sessionDir: dir, model: nativeDefaults ? undefined : "GPT 6 Luna", thinking: nativeDefaults ? undefined : "low" };
  const session = await adapter.spawn(spec, callbacks);
  owned.push(session);
  const wait = async (type: HarnessEvent["type"]) => {
    for (let i = 0; i < 200; i++) { const found = events.find(event => event.type === type); if (found) return found; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error(`Missing event ${type}`);
  };
  return { adapter, session, spec, callbacks, events, wait, owned };
}
for (const runtime of ["codex", "claude", "opencode"] as const) test(`${runtime} ACP uses exact advertised model/effort and supports repeated prompts`, async t => {
  const { session, wait, events } = await setup(t, runtime);
  assert.deepEqual((await session.getState()).runtimeInfo, {
    modelId: "gpt-6-luna", modelName: "GPT 6 Luna", reasoningEffort: "low", adapter: runtime === "opencode" ? "opencode 2.3.0" : undefined,
  });
  await session.prompt("one");
  assert.deepEqual((await wait("settled")), { type: "settled", aborted: false, finalText: "DONE one", error: undefined, stopReason: "end_turn" });
  events.length = 0;
  await session.prompt("two");
  const second = await wait("settled");
  assert.equal(second.type === "settled" && second.finalText, "DONE two");
});
test("ACP default aliases retain the native description without inventing a model id", async t => {
  const { session } = await setup(t, "claude", { FAKE_ACP_DEFAULT_MODEL: "1" }, true);
  const info = (await session.getState()).runtimeInfo;
  assert.equal(info?.modelId, "default");
  assert.equal(info?.modelName, "Native configured model (Default (recommended))");
});
test("ACP without model configuration leaves native identity unknown", async t => {
  const { session } = await setup(t, "claude", { FAKE_ACP_NO_CONFIG: "1" }, true);
  assert.equal((await session.getState()).runtimeInfo?.modelId, undefined);
  assert.equal((await session.getState()).runtimeInfo?.modelName, undefined);
});

test("ACP nested choices use each confirmed config response for the next option and final display", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-native-acp-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const methods: string[] = [];
  const selections: unknown[] = [];
  let model = "native-model", effort = "medium";
  const config = () => [
    { id: "model", category: "model", currentValue: model, options: [
      { name: "Models", options: [null, { value: "selected", name: effort === "low" ? "Final native label" : "Nested model" }] },
    ] },
    { id: "native_effort", category: "thought_level", currentValue: effort, options: [
      { name: "Efforts", options: [{ value: model === "selected" ? "low" : "medium", name: "Available effort" }] },
    ] },
  ];
  const client = {
    request: async (method: string, params: { configId?: string; value?: string }) => {
      methods.push(method);
      if (method === "initialize") return { protocolVersion: 1, agentInfo: { name: "native", version: "1" } };
      if (method === "session/new") return { sessionId: "config-session", configOptions: config() };
      if (method === "session/set_config_option") {
        selections.push(params);
        if (params.configId === "model") model = params.value!;
        if (params.configId === "native_effort") effort = params.value!;
        return { configOptions: config() };
      }
      throw new Error(`Unexpected request ${method}`);
    },
  };
  const session = Reflect.construct(NativeAcpSession, [client, {
    runtime: "codex", spec: { cwd: dir, sessionDir: dir, model: "Nested model", thinking: "low" },
  }]) as NativeAcpSession;
  await Reflect.get(session, "initialize").call(session);
  assert.deepEqual(methods, ["initialize", "session/new", "session/set_config_option", "session/set_config_option"]);
  assert.deepEqual(selections, [
    { sessionId: "config-session", configId: "model", value: "selected" },
    { sessionId: "config-session", configId: "native_effort", value: "low" },
  ]);
  assert.deepEqual((await session.getState()).runtimeInfo, {
    modelId: "selected", modelName: "Final native label", reasoningEffort: "low", adapter: "native 1",
  });
});

test("ACP rejects ambiguous nested model labels before sending a selection", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-native-acp-ambiguous-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const client = { request: async (method: string) => {
    if (method === "initialize") return { protocolVersion: 1 };
    assert.equal(method, "session/new", "an ambiguous label must not be sent to the agent");
    return { sessionId: "ambiguous-session", configOptions: [{ id: "model", options: [
      { value: "first", name: "Same label" },
      { options: [{ value: "second", name: "Same label" }] },
    ] }] };
  } };
  const session = Reflect.construct(NativeAcpSession, [client, {
    runtime: "codex", spec: { cwd: dir, sessionDir: dir, model: "Same label" },
  }]) as NativeAcpSession;
  await assert.rejects(Reflect.get(session, "initialize").call(session), {
    message: "ACP does not offer an unambiguous model=Same label; available: first, second",
  });
});
test("ACP permission requires a real offered option and repeated answers fail", async t => {
  const { session, wait } = await setup(t);
  await session.prompt("approve");
  const input = await wait("needs_input");
  assert.equal(input.type === "needs_input" && input.options?.length, 2);
  await assert.rejects(session.answer("native-permission", { value: "invented" }), /offered/);
  await session.answer("native-permission", { confirmed: true });
  await assert.rejects(session.answer("native-permission", { confirmed: true }), /No active/);
  const result = await wait("settled");
  assert.equal(result.type === "settled" && result.finalText, "ALLOWED");
});
test("ACP cancel settles the accepted turn as aborted", async t => {
  const { session, wait } = await setup(t);
  await session.prompt("slow");
  await session.abort();
  const result = await wait("settled");
  assert.equal(result.type === "settled" && result.aborted, true);
});
for (const runtime of ["codex", "opencode"] as const) test(`${runtime} ACP resume uses the original session and rejects cwd/runtime mismatches`, async t => {
  const { session, adapter, spec, callbacks, events, wait, owned } = await setup(t, runtime);
  const state = await session.getState();
  await session.close();
  const resumed = await adapter.resume(spec, state.sessionFile!, callbacks);
  owned.push(resumed);
  assert.equal((await resumed.getState()).sessionId, state.sessionId);
  await resumed.prompt("resumed");
  const result = await wait("settled");
  assert.equal(result.type === "settled" && result.finalText, "DONE resumed");
  assert.equal(events.some(event => event.type === "progress" && event.preview?.includes("REPLAY")), false);
  await assert.rejects(adapter.resume({ ...spec, cwd: os.tmpdir() }, state.sessionFile!, callbacks), /different cwd/);
  await assert.rejects(new NativeAcpAdapter(runtime === "codex" ? "opencode" : "codex").resume(spec, state.sessionFile!, callbacks), /another runtime/);
});
test("native ACP launch rejects shell shims and missing adapters instead of downloading", () => {
  assert.throws(() => resolveNativeAcpLaunch("codex", { HARNESS_SUPERVISOR_CODEX_ACP_ENTRY: "codex.cmd" }), /shell shim/);
  assert.throws(() => resolveNativeAcpLaunch("claude", { PATH: "" }, { modules: [], executables: [] }), /adapter is not installed/);
  assert.throws(() => resolveNativeAcpLaunch("codex", { PATH: "" }, { modules: [], executables: [] }), /npm i -g @agentclientprotocol\/codex-acp/);
});

test("both ACP adapters resolve from an installed module without a global PATH install", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hs-native-acp-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = path.join(root, "node_modules");
  for (const runtime of ["codex", "claude"] as const) {
    const name = runtime === "codex" ? "codex-acp" : "claude-agent-acp";
    const bridge = path.join(modules, "@agentclientprotocol", name);
    await mkdir(bridge, { recursive: true });
    await writeFile(path.join(bridge, "package.json"), JSON.stringify({ version: "1.0.0", bin: { [name]: "entry.js" } }));
    await writeFile(path.join(bridge, "entry.js"), "");
    const launch = resolveNativeAcpLaunch(runtime, { PATH: "" }, { modules: [modules], executables: [] });
    assert.equal(launch.file, process.execPath);
    assert.match(launch.args[0]!, /node_modules[\\/]@agentclientprotocol[\\/]/);
    assert.match(launch.description, /@agentclientprotocol/);
  }
});

test("Codex and Claude adapters stay optional peer dependencies and are never bundled by default", async () => {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  let manifest: Record<string, any> | undefined;
  for (let depth = 0; depth < 6 && !manifest; depth++) {
    try {
      const candidate = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (candidate.name === "harness-supervisor") manifest = candidate;
    } catch { /* keep walking up */ }
    directory = path.dirname(directory);
  }
  assert.ok(manifest, "the core package.json must be discoverable from the test location");
  for (const name of ["@agentclientprotocol/codex-acp", "@agentclientprotocol/claude-agent-acp"]) {
    assert.equal(manifest.dependencies?.[name], undefined, `${name} must not be a runtime dependency`);
    assert.ok(manifest.peerDependencies?.[name], `${name} must stay declared as a peer dependency`);
    assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true, `${name} must be an optional peer`);
  }
  for (const [runtime, pkg, envKey] of [
    ["codex", "@agentclientprotocol/codex-acp", "HARNESS_SUPERVISOR_CODEX_ACP_ENTRY"],
    ["claude", "@agentclientprotocol/claude-agent-acp", "HARNESS_SUPERVISOR_CLAUDE_ACP_ENTRY"],
  ] as const) {
    const notes = new NativeAcpAdapter(runtime).capabilities.notes ?? "";
    assert.doesNotMatch(notes, /\bbundled\b/i, `${runtime} runtime notes must not claim the optional adapter is bundled`);
    assert.match(notes, /optional/i);
    assert.match(notes, /neither bundles nor downloads/i);
    assert.ok(notes.includes(pkg), `${runtime} runtime notes should name ${pkg}`);
    assert.ok(notes.includes(envKey), `${runtime} runtime notes should name ${envKey}`);
  }
});

test("ACP rejects absent model choices and an unconfirmed model selection", async t => {
  const { adapter, spec, callbacks } = await setup(t);
  await assert.rejects(adapter.spawn({ ...spec, model: "invented-model" }, callbacks), /does not offer/);
  const mismatch = new NativeAcpAdapter("codex", { launch: { file: process.execPath, args: [fixture], env: { ...process.env, FAKE_ACP_MISMATCH: "1" }, description: "mismatching fake" } });
  await assert.rejects(mismatch.spawn(spec, callbacks), /did not confirm/);
});

test("ACP refuses recovery when the installed adapter does not advertise loadSession", async t => {
  const { session, adapter, spec, callbacks } = await setup(t, "codex", { FAKE_ACP_NO_LOAD: "1" });
  await assert.rejects(adapter.resume(spec, (await session.getState()).sessionFile!, callbacks), /does not advertise session\/load/);
});

test("a declined permission reply racing with a broken pipe cannot become an unhandled rejection", async () => {
  const session = Reflect.construct(NativeAcpSession, [{ pid: 1, reply: async () => { throw new Error("EPIPE"); } }, { callbacks: { onEvent() {}, onExit() {} } }]) as { request(method: string, value: unknown, id: string): boolean };
  assert.equal(session.request("session/request_permission", {}, "closed"), true);
  await new Promise(resolve => setImmediate(resolve));
});

test("OpenCode rejects unverified major versions before creating a session", async t => {
  for (const version of ["1.19.5", "3.0.0", ""]) {
    await assert.rejects(setup(t, "opencode", { FAKE_ACP_AGENT_VERSION: version }), /requires OpenCode v2/);
  }
});

test("OpenCode refuses premature slash-command completion and keeps child output out of its result", async t => {
  const { session, events, wait } = await setup(t, "opencode");
  await assert.rejects(session.prompt("/review repository"), /slash commands are not enabled/);
  assert.equal(events.some(event => event.type === "run_started"), false);
  await session.prompt("child-and-usage");
  const result = await wait("settled");
  assert.equal(result.type === "settled" && result.finalText, "PARENT");
  assert.ok(events.some(event => event.type === "progress" && event.preview === "CHILD" && event.detail?.includes("child-session")));
  assert.deepEqual(events.filter(event => event.type === "progress" && event.tool === "Write proof").map(event => event.type === "progress" && event.kind), ["tool_start", "tool_update", "tool_end"]);
  assert.deepEqual(events.find(event => event.type === "usage"), { type: "usage", usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2, reportedTotalTokens: 22 } });
});

test("OpenCode discovers an external v2 installation without executing npm shims or downloading", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hs-opencode-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = path.join(root, "node_modules"), pkg = path.join(modules, "@opencode/cli");
  await mkdir(pkg, { recursive: true });
  const script = path.join(pkg, "opencode.cjs"), binary = path.join(pkg, "opencode.exe");
  await writeFile(script, ""); await writeFile(binary, "");
  const manifest = (version: string, bin: string) => writeFile(path.join(pkg, "package.json"), JSON.stringify({ version, bin: { opencode2: bin } }));
  const discovery = { modules: [modules], executables: [] };
  await manifest("2.3.0", "opencode.cjs");
  const js = resolveNativeAcpLaunch("opencode", {}, discovery);
  assert.equal(js.file, process.execPath); assert.deepEqual(js.args, [script, "acp"]);
  await manifest("2.3.0", "opencode.exe");
  const exe = resolveNativeAcpLaunch("opencode", {}, discovery);
  assert.equal(exe.file, binary); assert.deepEqual(exe.args, ["acp"]);
  await manifest("1.19.5", "opencode.exe");
  assert.throws(() => resolveNativeAcpLaunch("opencode", {}, discovery), /HS does not install or download/);
  const explicit = resolveNativeAcpLaunch("opencode", { HARNESS_SUPERVISOR_OPENCODE_ACP_ENTRY: script }, discovery);
  assert.deepEqual(explicit.args, [script, "acp"]);
  assert.throws(() => resolveNativeAcpLaunch("opencode", { HARNESS_SUPERVISOR_OPENCODE_ACP_ENTRY: "opencode.cmd" }, discovery), /shell shim/);
  for (const runtime of ["codex", "claude"] as const) {
    const name = runtime === "codex" ? "codex-acp" : "claude-agent-acp";
    const bridge = path.join(modules, "@agentclientprotocol", name);
    await mkdir(bridge, { recursive: true });
    await writeFile(path.join(bridge, "package.json"), JSON.stringify({ version: "1.0.0", bin: { [name]: "entry-without-extension" } }));
    await writeFile(path.join(bridge, "entry-without-extension"), "");
    const launch = resolveNativeAcpLaunch(runtime, {}, discovery);
    assert.equal(launch.file, process.execPath);
    assert.deepEqual(launch.args, [path.join(bridge, "entry-without-extension")]);
  }
});
