import assert from "node:assert/strict";
import test from "node:test";
import {
  INPUT_TIMEOUT_ENV,
  MCODE_INPUT_TIMEOUT_ENV,
  PI_INPUT_TIMEOUT_ENV,
  pickInputTimeoutMs,
  resolveInputTimeoutMs,
  resolveOptionalInputTimeoutMs,
} from "../../src/input-timeout.js";

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

test("a runtime-specific timeout overrides the shared value", () => {
  const previousGeneric = process.env[INPUT_TIMEOUT_ENV];
  const previousSpecific = process.env[MCODE_INPUT_TIMEOUT_ENV];
  try {
    process.env[INPUT_TIMEOUT_ENV] = "600000";
    process.env[MCODE_INPUT_TIMEOUT_ENV] = "120000";
    assert.equal(resolveInputTimeoutMs(1_000, MCODE_INPUT_TIMEOUT_ENV), 120_000);
    delete process.env[MCODE_INPUT_TIMEOUT_ENV];
    assert.equal(resolveInputTimeoutMs(1_000, MCODE_INPUT_TIMEOUT_ENV), 600_000);
    process.env[MCODE_INPUT_TIMEOUT_ENV] = "not-a-number";
    assert.equal(
      resolveInputTimeoutMs(1_000, MCODE_INPUT_TIMEOUT_ENV),
      1_000,
      "an invalid override falls back to the default, not silently to the shared value",
    );
  } finally {
    if (previousGeneric === undefined) delete process.env[INPUT_TIMEOUT_ENV];
    else process.env[INPUT_TIMEOUT_ENV] = previousGeneric;
    if (previousSpecific === undefined) delete process.env[MCODE_INPUT_TIMEOUT_ENV];
    else process.env[MCODE_INPUT_TIMEOUT_ENV] = previousSpecific;
  }
});

test("Pi's opt-in cap is disabled by default and uses the stricter timeout", () => {
  const previous = process.env[PI_INPUT_TIMEOUT_ENV];
  try {
    delete process.env[PI_INPUT_TIMEOUT_ENV];
    assert.equal(resolveOptionalInputTimeoutMs(PI_INPUT_TIMEOUT_ENV), 0);
    assert.equal(pickInputTimeoutMs(undefined, 0), undefined);
    assert.equal(pickInputTimeoutMs(120_000, 0), 120_000);
    process.env[PI_INPUT_TIMEOUT_ENV] = "60000";
    assert.equal(resolveOptionalInputTimeoutMs(PI_INPUT_TIMEOUT_ENV), 60_000);
    assert.equal(pickInputTimeoutMs(undefined, 60_000), 60_000);
    assert.equal(pickInputTimeoutMs(30_000, 60_000), 30_000);
    assert.equal(pickInputTimeoutMs(120_000, 60_000), 60_000);
    process.env[PI_INPUT_TIMEOUT_ENV] = "0";
    assert.equal(resolveOptionalInputTimeoutMs(PI_INPUT_TIMEOUT_ENV), 0);
  } finally {
    if (previous === undefined) delete process.env[PI_INPUT_TIMEOUT_ENV];
    else process.env[PI_INPUT_TIMEOUT_ENV] = previous;
  }
});