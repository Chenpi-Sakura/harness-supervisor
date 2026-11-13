import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectProcess, readProcessCommandLine, readProcessDetails } from "../../src/util/process.js";

test("reads the command line of a live process", async () => {
  const commandLine = await readProcessCommandLine(process.pid);
  // Some hardened environments deny introspection; the mechanism must degrade
  // to `null` (unknown) instead of throwing.
  if (commandLine !== null) {
    assert.match(commandLine, /node/i, `unexpected command line: ${commandLine}`);
  }
  assert.equal(await readProcessCommandLine(-1), null);
  assert.equal(await readProcessCommandLine(0), null);
});

test("verifies identity against tokens that belong to the worker", async () => {
  const script = process.argv[1] ?? "";
  const mine = await inspectProcess(process.pid, [script]);
  assert.equal(mine.alive, true);
  if (mine.commandLine !== null) {
    assert.equal(mine.verified, true);
  }

  const reused = await inspectProcess(process.pid, ["hs-definitely-not-in-argv-token"]);
  assert.equal(reused.alive, true);
  if (reused.commandLine !== null) {
    assert.equal(reused.verified, false, "a live PID without our tokens must be reported as not ours");
  }

  const missing = await inspectProcess(undefined, ["anything"]);
  assert.equal(missing.alive, false);
  assert.equal(missing.verified, null);
  assert.equal(missing.startedAt, null);
});

test("reads the creation time of a live process", async () => {
  const identity = await inspectProcess(process.pid, []);
  assert.equal(identity.alive, true);
  if (process.platform === "win32" || process.platform === "linux") {
    assert.notEqual(identity.startedAt, null, "the creation time must be readable on this platform");
  }
  if (identity.startedAt !== null) {
    const started = Date.parse(identity.startedAt);
    assert.ok(Number.isFinite(started), `unparsable start time: ${identity.startedAt}`);
    assert.ok(started <= Date.now() + 1000, "the creation time must not be in the future");
    const age = Date.now() - started;
    assert.ok(
      Math.abs(age - process.uptime() * 1000) < 10_000,
      `creation time ${identity.startedAt} disagrees with the process uptime (${process.uptime()}s)`,
    );
  }
});

test("reads command line and creation time with one query", async () => {
  const details = await readProcessDetails(process.pid);
  if (process.platform === "win32" || process.platform === "linux") {
    assert.notEqual(details.startedAt, null, "the creation time must be readable on this platform");
  }
  const invalid = await readProcessDetails(-1);
  assert.deepEqual(invalid, { commandLine: null, startedAt: null });
});
