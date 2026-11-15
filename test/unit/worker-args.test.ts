import { test } from "node:test";
import assert from "node:assert/strict";
import { validateExtraArgs } from "../../src/worker-args.js";
import { validateExtraArgs as validatePiExtraArgs } from "../../src/adapters/pi/launch.js";

test("shared extraArgs validation preserves every reserved option and equals form", () => {
  for (const flag of [
    "--mode", "--session", "--session-dir", "--session-id", "--continue",
    "--resume", "--print", "--help", "--no-session", "--api-key",
  ]) {
    for (const args of [[flag, "value"], [`${flag}=value`]]) {
      assert.throws(() => validateExtraArgs(args), {
        message: `extraArgs may not override supervisor-managed option ${flag}`,
      });
    }
  }
});

test("shared extraArgs validation preserves argument shape and permitted values", () => {
  for (const args of [["--custom\0value"], [1], [undefined], [null]]) {
    assert.throws(() => validateExtraArgs(args as string[]), {
      message: "extraArgs must be strings without NUL bytes",
    });
  }
  for (const args of [undefined, [], ["--no-extensions", "--no-skills"], ["--session-custom=value"], ["", "value=with=equals"]]) {
    assert.doesNotThrow(() => validateExtraArgs(args));
  }
});

test("Pi retains its existing validation export", () => {
  assert.equal(validatePiExtraArgs, validateExtraArgs);
});
