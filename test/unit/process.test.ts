import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectProcess, readProcessCommandLine } from "../../src/util/process.js";

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
});
