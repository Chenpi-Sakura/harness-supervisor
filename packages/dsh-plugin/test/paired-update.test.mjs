import assert from "node:assert/strict";
import test from "node:test";
import { syncPairedCore } from "../src/paired-update.js";

function setup({ version = "0.11.1", candidateVersion = "0.12.2", external = false, managed = true, intent, capabilities = { managedRuntime: true, drain: true }, mutate, current = () => true } = {}) {
  const calls = [];
  const candidate = { id: "new-core", version: candidateVersion };
  const options = { external, candidate, isCurrent: current, intentId: "plugin-once", request: async (method, args) => {
    calls.push([method, args]);
    if (method === "info") return { version, capabilities };
    if (method === "runtime_update_status") return { managed, activeRuntimeId: managed ? "old-core" : undefined, intent };
    return mutate ? mutate(args) : { id: args.intentId, phase: "draining" };
  } };
  return { calls, options };
}

test("new bundled core registers the daemon-owned drain once, without stopping workers", async () => {
  const { calls, options } = setup();
  assert.deepEqual(await syncPairedCore(options), { state: "draining", intentId: "plugin-once" });
  assert.deepEqual(calls.map(([method]) => method), ["info", "runtime_update_status", "runtime_update"]);
  assert.deepEqual(calls[2][1], { runtimeId: "new-core", intentId: "plugin-once" });
});
test("same/older/unparseable versions never replace the running core", async () => {
  for (const version of ["0.12.2", "0.13.0", "0.12.3", "unknown", "0.12.1-dev"]) {
    const { calls, options } = setup({ version });
    await syncPairedCore(options);
    assert.equal(calls.some(([method]) => method === "runtime_update"), false, version);
  }
  const { options } = setup({ version: "0.9.9", candidateVersion: "0.10.0" });
  assert.equal((await syncPairedCore(options)).state, "draining", "compare SemVer numerically");
  for (const candidateVersion of ["unknown", "0.12.2-beta", null]) {
    const { calls, options } = setup({ candidateVersion });
    await syncPairedCore(options);
    assert.equal(calls.some(([method]) => method === "runtime_update"), false);
  }
});
test("external, unsupported and unmanaged instances remain untouched", async () => {
  for (const override of [{ external: true }, { managed: false }, { capabilities: {} }]) {
    const { calls, options } = setup(override);
    await syncPairedCore(options);
    assert.equal(calls.some(([method]) => method === "runtime_update"), false);
    if (override.external) assert.equal(calls.length, 0);
  }
});
test("pending, cancelled and failed target intents are not duplicated or overridden", async () => {
  for (const phase of ["draining", "switching", "verifying", "cancelled", "failed", "rolled_back", "recovery_required"]) {
    const { calls, options } = setup({ intent: { id: "existing", targetRuntimeId: "new-core", phase } });
    assert.equal((await syncPairedCore(options)).state, phase);
    assert.equal(calls.length, 2);
  }
  for (const phase of ["draining", "switching", "verifying", "recovery_required"]) {
    const { calls, options } = setup({ intent: { id: "other", targetRuntimeId: "other-core", phase } });
    assert.equal((await syncPairedCore(options)).state, "conflict");
    assert.equal(calls.length, 2);
  }
});
test("source disposal prevents updates after async checks; uncertain mutations never retry", async () => {
  for (const stopAt of [1, 2, 3, 4]) {
    let checks = 0;
    const { calls, options } = setup({ current: () => ++checks < stopAt });
    await syncPairedCore(options);
    assert.equal(calls.some(([method]) => method === "runtime_update"), false);
  }
  for (const code of ["CONFLICT", "TIMEOUT"]) {
    const { calls, options } = setup({ mutate: () => { throw Object.assign(new Error(code), { code }); } });
    assert.equal((await syncPairedCore(options)).state, code === "CONFLICT" ? "conflict" : "unconfirmed");
    assert.equal(calls.filter(([method]) => method === "runtime_update").length, 1);
  }
});
