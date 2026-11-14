import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolvePluginState } from "../src/state-dir.js";

test("DSH defaults to its own instance even when a global HS home is inherited", () => {
  const home = path.resolve("test-home");
  const dsh = path.resolve("test-dsh");
  const state = resolvePluginState({}, { DSH_HOME: dsh, HARNESS_SUPERVISOR_HOME: path.resolve("global-hs") }, home);
  assert.equal(state.stateDir, path.join(dsh, "harness-supervisor"));
  assert.equal(state.namespace, dsh);
  assert.notEqual(resolvePluginState({}, { DSH_HOME: path.resolve("other-dsh") }, home).stateDir, state.stateDir);
});

test("explicit isolated directories work, shared default directories are rejected", () => {
  const home = path.resolve("test-home");
  const shared = path.resolve("global-hs");
  assert.throws(() => resolvePluginState({ stateDir: shared }, { HARNESS_SUPERVISOR_HOME: shared }, home), /dedicated stateDir/);
  assert.throws(() => resolvePluginState({ stateDir: path.join(home, ".harness-supervisor") }, {}, home), /dedicated stateDir/);
  assert.equal(resolvePluginState({ stateDir: path.resolve("private-hs") }, {}, home).stateDir, path.resolve("private-hs"));
});
test("external npm mode defaults to the standalone instance", () => {
  const home = path.resolve("test-home");
  const standalone = path.resolve("standalone-state");
  assert.equal(resolvePluginState({ coreSource: "npm" }, { HARNESS_SUPERVISOR_HOME: standalone }, home).stateDir, standalone);
  assert.equal(resolvePluginState({ coreSource: "custom" }, {}, home).stateDir, path.join(home, ".harness-supervisor"));
});
