import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldClearPendingInput } from "../../src/supervisor.js";

/**
 * The harness can withdraw a request it no longer needs (mcode emits
 * `permission_withdrawn` with the withdrawn requestId in `detail`). The
 * supervisor must then stop reporting awaiting_input, otherwise the notification
 * freshness gate keeps treating the dead request as current and wakes the main
 * agent for something nobody can answer.
 *
 * The matching rules are the contract, so they are tested directly: kind +
 * exact current requestId, with answers/cancellations winning the race.
 */
const base = {
  kind: "permission_withdrawn",
  detail: "ui-7",
  pendingRequestId: "ui-7",
  cancelRequested: false,
  finalizing: false,
  terminal: false,
};

test("a withdrawal for the current request clears it", () => {
  assert.equal(shouldClearPendingInput(base), true);
  // Adapters may pad the id; surrounding whitespace is not a different request.
  assert.equal(shouldClearPendingInput({ ...base, detail: " ui-7 " }), true);
  // The alternative progress kind is treated the same way.
  assert.equal(shouldClearPendingInput({ ...base, kind: "input_withdrawn" }), true);
});

test("a withdrawal never guesses: other kinds, other ids and missing ids are ignored", () => {
  assert.equal(shouldClearPendingInput({ ...base, kind: "tool_end" }), false);
  assert.equal(shouldClearPendingInput({ ...base, detail: undefined }), false);
  assert.equal(shouldClearPendingInput({ ...base, detail: "" }), false);
  assert.equal(shouldClearPendingInput({ ...base, detail: "ui-old" }), false, "stale withdrawal");
  assert.equal(shouldClearPendingInput({ ...base, pendingRequestId: undefined }), false);
});

test("an answer already in flight, a cancellation or a finished run wins over a withdrawal", () => {
  assert.equal(shouldClearPendingInput({ ...base, answeringRequestId: "ui-7" }), false);
  assert.equal(shouldClearPendingInput({ ...base, answeringRequestId: "ui-other" }), false);
  assert.equal(shouldClearPendingInput({ ...base, cancelRequested: true }), false);
  assert.equal(shouldClearPendingInput({ ...base, finalizing: true }), false);
  assert.equal(shouldClearPendingInput({ ...base, terminal: true }), false);
});