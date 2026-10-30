import assert from "node:assert/strict";
import test from "node:test";
import { INPUT_TIMEOUT_ENV, resolveInputTimeoutMs } from "../../src/input-timeout.js";

test("input timeout env is bounded and falls back on invalid values", () => {
  const previous = process.env[INPUT_TIMEOUT_ENV];
  try {
    delete process.env[INPUT_TIMEOUT_ENV];
    assert.equal(resolveInputTimeoutMs(1_000), 1_000);
    process.env[INPUT_TIMEOUT_ENV] = "60000";
    assert.equal(resolveInputTimeoutMs(1_000), 60_000);
    process.env[INPUT_TIMEOUT_ENV] = "86400000";
    assert.equal(resolveInputTimeoutMs(1_000), 86_400_000);
    process.env[INPUT_TIMEOUT_ENV] = "59999";
    assert.equal(resolveInputTimeoutMs(1_000), 1_000);
    process.env[INPUT_TIMEOUT_ENV] = "86400001";
    assert.equal(resolveInputTimeoutMs(1_000), 1_000);
    process.env[INPUT_TIMEOUT_ENV] = "not-a-number";
    assert.equal(resolveInputTimeoutMs(1_000), 1_000);
  } finally {
    if (previous === undefined) delete process.env[INPUT_TIMEOUT_ENV];
    else process.env[INPUT_TIMEOUT_ENV] = previous;
  }
});