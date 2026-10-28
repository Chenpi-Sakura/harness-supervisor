import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callerMetaRejection,
  callerThreadFromMeta,
  isThreadUuid,
} from "../../src/caller-thread.js";

const THREAD_A = "01a181c6-823f-7fe0-92b9-b8cf38c5bb41";
const THREAD_B = "01a181c4-0ccf-74e3-b367-e3d72a0756bb";

test("caller identity comes from the per-call MCP meta, not a process global", () => {
  assert.equal(isThreadUuid(THREAD_A), true);
  assert.equal(isThreadUuid("not-a-thread"), false);
  assert.equal(isThreadUuid(undefined), false);
  assert.deepEqual(
    callerThreadFromMeta({
      threadId: THREAD_A,
      sessionId: THREAD_A,
      "x-codex-turn-metadata": { thread_id: THREAD_A, turn_id: "turn-1" },
    }),
    { threadId: THREAD_A, sessionId: THREAD_A },
  );
});

test("missing or malformed caller identity is rejected instead of guessed", () => {
  assert.equal(callerThreadFromMeta(undefined), undefined);
  assert.equal(callerThreadFromMeta(null), undefined);
  assert.equal(callerThreadFromMeta([]), undefined);
  assert.equal(callerThreadFromMeta({}), undefined);
  assert.equal(callerThreadFromMeta({ threadId: "recent-session-name" }), undefined);
  assert.equal(callerThreadFromMeta({ threadId: THREAD_A.toUpperCase() }), undefined,
    "a non-canonical UUID is not a Codex thread id");
});

test("conflicting duplicate thread ids are rejected rather than picking one", () => {
  assert.equal(
    callerThreadFromMeta({
      threadId: THREAD_A,
      "x-codex-turn-metadata": { thread_id: THREAD_B },
    }),
    undefined,
  );
  assert.deepEqual(callerThreadFromMeta({ threadId: THREAD_B }), { threadId: THREAD_B });
});

test("rejection reasons are explicit so a wakeable fallback can be warned", () => {
  assert.equal(callerMetaRejection(undefined), undefined, "absence is not a rejection");
  assert.equal(callerMetaRejection({}), undefined);
  assert.equal(callerMetaRejection({ threadId: THREAD_A }), undefined);
  assert.equal(callerMetaRejection({ threadId: "not-a-uuid" }), "invalid");
  assert.equal(
    callerMetaRejection({
      threadId: THREAD_A,
      "x-codex-turn-metadata": { thread_id: THREAD_B },
    }),
    "conflict",
  );
});