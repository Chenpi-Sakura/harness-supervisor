import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INPUT_TIMEOUT_MS,
  INPUT_TIMEOUT_ENV,
  MCODE_INPUT_TIMEOUT_ENV,
  PI_INPUT_TIMEOUT_ENV,
  QODER_INPUT_TIMEOUT_ENV,
  pickInputTimeoutMs,
  resolveRuntimeInputTimeoutMs,
} from "../../src/input-timeout.js";

const envKeys = [INPUT_TIMEOUT_ENV, QODER_INPUT_TIMEOUT_ENV, MCODE_INPUT_TIMEOUT_ENV, PI_INPUT_TIMEOUT_ENV] as const;

function withEnv(values: Partial<Record<(typeof envKeys)[number], string>>, fn: () => void): void {
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    fn();
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the shared timeout is the default for every runtime", () => {
  withEnv({ [INPUT_TIMEOUT_ENV]: "600000" }, () => {
    assert.equal(
      resolveRuntimeInputTimeoutMs({ specificEnv: QODER_INPUT_TIMEOUT_ENV, defaultMs: 1_800_000 }),
      600_000,
    );
    assert.equal(
      resolveRuntimeInputTimeoutMs({ specificEnv: MCODE_INPUT_TIMEOUT_ENV, defaultMs: 1_800_000 }),
      600_000,
    );
    assert.equal(
      resolveRuntimeInputTimeoutMs({
        specificEnv: PI_INPUT_TIMEOUT_ENV,
        defaultMs: DEFAULT_INPUT_TIMEOUT_MS,
        allowDisabled: true,
      }),
      600_000,
    );
  });
});

test("a runtime-specific value overrides the shared value", () => {
  withEnv(
    {
      [INPUT_TIMEOUT_ENV]: "600000",
      [QODER_INPUT_TIMEOUT_ENV]: "120000",
      [MCODE_INPUT_TIMEOUT_ENV]: "180000",
      [PI_INPUT_TIMEOUT_ENV]: "240000",
    },
    () => {
      assert.equal(
        resolveRuntimeInputTimeoutMs({ specificEnv: QODER_INPUT_TIMEOUT_ENV, defaultMs: 1_800_000 }),
        120_000,
      );
      assert.equal(
        resolveRuntimeInputTimeoutMs({ specificEnv: MCODE_INPUT_TIMEOUT_ENV, defaultMs: 1_800_000 }),
        180_000,
      );
      assert.equal(
        resolveRuntimeInputTimeoutMs({
          specificEnv: PI_INPUT_TIMEOUT_ENV,
          defaultMs: 0,
          allowDisabled: true,
        }),
        240_000,
      );
    },
  );
});

test("invalid specific values fall through to the shared value, then the built-in default", () => {
  withEnv({ [INPUT_TIMEOUT_ENV]: "600000", [QODER_INPUT_TIMEOUT_ENV]: "invalid" }, () => {
    assert.equal(
      resolveRuntimeInputTimeoutMs({ specificEnv: QODER_INPUT_TIMEOUT_ENV, defaultMs: 1_800_000 }),
      600_000,
      "an invalid specific value must not discard the shared default",
    );
  });
  withEnv({ [QODER_INPUT_TIMEOUT_ENV]: "59999" }, () => {
    assert.equal(
      resolveRuntimeInputTimeoutMs({ specificEnv: QODER_INPUT_TIMEOUT_ENV, defaultMs: 1_800_000 }),
      1_800_000,
      "values below one minute are ignored",
    );
  });
});

test("Pi defaults to 30 minutes and treats zero as an explicit disable", () => {
  withEnv({}, () => {
    assert.equal(
      resolveRuntimeInputTimeoutMs({
        specificEnv: PI_INPUT_TIMEOUT_ENV,
        defaultMs: DEFAULT_INPUT_TIMEOUT_MS,
        allowDisabled: true,
      }),
      DEFAULT_INPUT_TIMEOUT_MS,
    );
  });
  withEnv({ [INPUT_TIMEOUT_ENV]: "600000", [PI_INPUT_TIMEOUT_ENV]: "0" }, () => {
    assert.equal(
      resolveRuntimeInputTimeoutMs({
        specificEnv: PI_INPUT_TIMEOUT_ENV,
        defaultMs: DEFAULT_INPUT_TIMEOUT_MS,
        allowDisabled: true,
      }),
      0,
      "the runtime-specific zero must disable the shared value for Pi",
    );
  });
});

test("zero is not a valid disable for Qoder or MiniMax Code", () => {
  withEnv({ [INPUT_TIMEOUT_ENV]: "600000", [QODER_INPUT_TIMEOUT_ENV]: "0" }, () => {
    assert.equal(
      resolveRuntimeInputTimeoutMs({ specificEnv: QODER_INPUT_TIMEOUT_ENV, defaultMs: 1_800_000 }),
      600_000,
    );
  });
});

test("Pi keeps the stricter of its native timeout and the HS cap", () => {
  assert.equal(pickInputTimeoutMs(undefined, 0), undefined);
  assert.equal(pickInputTimeoutMs(120_000, 0), 120_000);
  assert.equal(pickInputTimeoutMs(undefined, 60_000), 60_000);
  assert.equal(pickInputTimeoutMs(30_000, 60_000), 30_000);
  assert.equal(pickInputTimeoutMs(120_000, 60_000), 60_000);
});