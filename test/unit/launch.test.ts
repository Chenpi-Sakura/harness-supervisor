import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  resolvePiLaunch,
  validateExtraArgs,
} from "../../src/adapters/pi/launch.js";

const fakeEntry = fileURLToPath(new URL("../fixtures/fake-harness.js", import.meta.url));

test("JS entry launches as node <entry> <pi args>, not node <pi args> <entry>", () => {
  const launch = resolvePiLaunch({
    HARNESS_SUPERVISOR_PI_ENTRY: fakeEntry,
    HARNESS_SUPERVISOR_PI_ARGS: '["--no-extensions","--no-skills"]',
  });
  assert.equal(launch.file, process.execPath);
  assert.deepEqual(launch.args, [fakeEntry, "--no-extensions", "--no-skills"]);
});

test("explicit executable gets Pi args after it", () => {
  const launch = resolvePiLaunch({
    HARNESS_SUPERVISOR_PI_BIN: process.execPath,
    HARNESS_SUPERVISOR_PI_ARGS: '["--no-extensions"]',
  });
  assert.equal(launch.file, process.execPath);
  assert.deepEqual(launch.args, ["--no-extensions"]);
});

test("malformed Pi args env is rejected", () => {
  assert.throws(() =>
    resolvePiLaunch({
      HARNESS_SUPERVISOR_PI_ENTRY: fakeEntry,
      HARNESS_SUPERVISOR_PI_ARGS: "not-json",
    }),
  );
  assert.throws(() =>
    resolvePiLaunch({
      HARNESS_SUPERVISOR_PI_ENTRY: fakeEntry,
      HARNESS_SUPERVISOR_PI_ARGS: "[1,2]",
    }),
  );
});

test("extraArgs cannot override supervisor-managed Pi options", () => {
  for (const flag of [
    "--mode",
    "--session",
    "--session-dir",
    "--session-id",
    "--no-session",
    "--api-key",
  ]) {
    assert.throws(() => validateExtraArgs([flag, "value"]), new RegExp(flag));
  }
  assert.doesNotThrow(() => validateExtraArgs(["--no-extensions", "--no-skills"]));
});
