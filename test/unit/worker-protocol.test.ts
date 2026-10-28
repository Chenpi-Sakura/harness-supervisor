import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKER_PROTOCOL_MARKER,
  withWorkerProtocol,
} from "../../src/worker-protocol.js";

test("worker protocol prefixes a task once and can be disabled", () => {
  const prompt = "implement the parser";
  const wrapped = withWorkerProtocol(prompt, {});
  assert.ok(wrapped.startsWith(WORKER_PROTOCOL_MARKER));
  assert.ok(wrapped.endsWith(prompt), "the original task stays at the end");
  assert.equal(
    withWorkerProtocol(wrapped, {}),
    wrapped,
    "a prompt that already carries the block is sent unchanged",
  );
  assert.equal(
    withWorkerProtocol(prompt, { HARNESS_SUPERVISOR_WORKER_PROTOCOL: "0" }),
    prompt,
    "the compatibility switch restores the original prompt",
  );
});