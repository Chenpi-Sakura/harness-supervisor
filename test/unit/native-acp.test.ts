import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { NativeAcpAdapter } from "../../src/adapters/native-acp/adapter.js";
import { resolveNativeAcpLaunch } from "../../src/adapters/native-acp/launch.js";
import { NativeAcpSession } from "../../src/adapters/native-acp/session.js";
import type { HarnessEvent, HarnessSession } from "../../src/types.js";
const fixture = fileURLToPath(new URL("../fixtures/fake-native-acp.js", import.meta.url));
async function setup(t: { after: (fn: () => Promise<void>) => void }, runtime: "codex" | "claude" = "codex", extraEnv = {}, nativeDefaults = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-native-acp-"));
  const owned: HarnessSession[] = [];
  t.after(async () => { for (const session of owned) await session.close({ graceMs: 100 }); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const adapter = new NativeAcpAdapter(runtime, { launch: { file: process.execPath, args: [fixture], env: { ...process.env, ...extraEnv }, description: "fake ACP" }, abortTimeoutMs: 200 });
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
for (const runtime of ["codex", "claude"] as const) test(`${runtime} ACP uses exact advertised model/effort and supports repeated prompts`, async t => {
  const { session, wait, events } = await setup(t, runtime);
  assert.deepEqual((await session.getState()).runtimeInfo, {
    modelId: "gpt-6-luna", modelName: "GPT 6 Luna", reasoningEffort: "low", adapter: undefined,
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
test("ACP resume uses the original session and rejects cwd/runtime mismatches", async t => {
  const { session, adapter, spec, callbacks, events, wait, owned } = await setup(t);
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
});
test("native ACP launch rejects shell shims and missing adapters instead of downloading", () => {
  assert.throws(() => resolveNativeAcpLaunch("codex", { HARNESS_SUPERVISOR_CODEX_ACP_ENTRY: "codex.cmd" }), /shell shim/);
  assert.throws(() => resolveNativeAcpLaunch("claude", { PATH: "" }), /npm install -g/);
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
