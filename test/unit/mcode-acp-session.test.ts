import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McodeAcpSession } from "../../src/adapters/mcode/session.js";
import { SupervisorError } from "../../src/errors.js";
import type { HarnessEvent } from "../../src/types.js";

const STUB_ENTRY = fileURLToPath(new URL("../fixtures/stub-mcode-acp.js", import.meta.url));

interface HarnessRun {
  session: McodeAcpSession;
  events: HarnessEvent[];
  stderr: string[];
}

async function pendingInput(events: HarnessEvent[]) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const event = events.find(event => event.type === "needs_input");
    if (event?.type === "needs_input") return event;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("the native permission request was not surfaced");
}

for (const scenario of ["ids", "anonymous", "snapshot", "late", "long", "no-final"]) {
  test(`final report follows native message boundaries (${scenario})`, async (t) => {
    const { session, events } = await runAgainstStub(t, { STUB_MESSAGES: scenario });
    for (let turn = 0; turn < 2; turn += 1) {
      const offset = events.length;
      await session.prompt("report");
      const deadline = Date.now() + 3000;
      while (!events.slice(offset).some(event => event.type === "settled") && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const current = events.slice(offset);
      const settled = current.find(event => event.type === "settled");
      assert.ok(settled?.type === "settled");
      const expected = scenario === "no-final" ? "" : `Final report${scenario === "long" ? "x".repeat(20000) : ""}`;
      assert.equal(settled.finalText, expected);
      assert.ok(current.some(event => event.type === "progress" && event.preview === "Earlier progress."));
    }
  });
}

/**
 * Drives the real adapter against a stub agent that numbers its reverse
 * requests from zero, like the real MiniMax Code agent does.
 */
async function runAgainstStub(
  t: { after(fn: () => void): void },
  env: Record<string, string> = {},
  requestTimeoutMs?: number,
): Promise<HarnessRun> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-mcode-stub-"));
  const events: HarnessEvent[] = [];
  const stderr: string[] = [];
  const session = await McodeAcpSession.start({
    launch: {
      file: process.execPath,
      args: [STUB_ENTRY],
      description: "stub mcode acp",
      env: { ...process.env, ...env },
    },
    args: [],
    requestTimeoutMs,
    cwd: dir,
    sessionDir: dir,
    callbacks: {
      onEvent: (event) => events.push(event),
      onExit: () => undefined,
    },
    onStderr: (text) => stderr.push(text),
  });
  t.after(async () => {
    await session.close({ graceMs: 500 }).catch(() => undefined);
  });
  return { session, events, stderr };
}

test("ACP prompt survives the control request deadline while waiting for native input", async (t) => {
  const { session, events } = await runAgainstStub(t, {}, 500);
  await session.prompt("long-running audit");
  const pending = await pendingInput(events);
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(events.some(event => event.type === "settled"), false);
  assert.equal(events.some(event => event.type === "run_error"), false);
  await session.answer(pending.requestId, { value: "Allow once" });
  await new Promise(resolve => setTimeout(resolve, 150));
  const settled = events.find(event => event.type === "settled");
  assert.ok(settled?.type === "settled");
  assert.equal(settled.aborted, false);
  assert.match(settled.finalText ?? "", /STUB_ANSWERED/);
});

test("control RPCs still time out without terminating the ongoing prompt", async (t) => {
  const { session, events } = await runAgainstStub(t, { STUB_IGNORE_STEER: "1" }, 500);
  await session.prompt("working");
  const pending = await pendingInput(events);
  await assert.rejects(session.steer("adjust"), (error: unknown) =>
    error instanceof SupervisorError && error.code === "HARNESS_TIMEOUT" && error.message.includes("mcode/session/steer"));
  assert.equal(events.some(event => event.type === "settled"), false);
  await session.answer(pending.requestId, { value: "Allow once" });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(events.some(event => event.type === "settled"));
});

test("permission context includes the complete actual arguments instead of only the title", async (t) => {
  const command = `echo ${"x".repeat(2500)} CONTEXT_END`;
  const { session, events } = await runAgainstStub(t, { STUB_PERMISSION_COMMAND: command });
  await session.prompt("inspect");
  const pending = await pendingInput(events);
  assert.ok(pending.message?.includes(command));
  assert.match(pending.message ?? "", /CONTEXT_END/);
  assert.match(pending.message ?? "", /Input:/);
  assert.deepEqual(pending.options, ["Allow once", "Always allow", "Deny"]);
  await session.answer(pending.requestId, { value: "Deny" });
});

test("a huge native permission payload stays bounded instead of flooding the caller", async (t) => {
  // The native rawInput is the decision context for an approval, so it is kept.
  // It is also the agent's own payload: a single tool call can carry a very
  // large file body. The supervisor hands the pending input to the caller
  // verbatim, so the adapter must keep it bounded.
  const { session, events } = await runAgainstStub(t, { STUB_PERMISSION_PAD: "20000" });
  await session.prompt("inspect");
  const pending = await pendingInput(events);
  assert.ok(pending.message);
  assert.ok(
    pending.message.length <= 8200,
    `the permission context must stay bounded, got ${pending.message.length} chars`,
  );
  assert.match(pending.message ?? "", /Input:/);
  assert.match(pending.message ?? "", /echo x{100}/, "the real command must still be visible");
  assert.match(pending.message ?? "", /\[truncated \d+ chars\]/, "missing arguments must be visible to the approver");
  await session.answer(pending.requestId, { value: "Deny" });
});

test("the supervisor keeps its request ids apart from the agent's reverse requests", async (t) => {
  const { session, events, stderr } = await runAgainstStub(t);

  const requestIds = stderr
    .join("")
    .split(/\r?\n/)
    .filter((line) => line.includes("STUB_CLIENT_REQUEST_ID"))
    .map((line) => line.slice(line.indexOf("{")).trim());
  assert.ok(requestIds.length > 0, "the stub must observe the supervisor's requests");

  for (const raw of requestIds) {
    const id = (JSON.parse(raw) as { id: unknown }).id;
    assert.equal(
      typeof id,
      "string",
      "supervisor request ids must be strings, because the agent uses numeric reverse-request ids",
    );
    assert.match(String(id), /^hs-\d+$/, "supervisor request ids must carry a distinct prefix");
  }

  // The agent sends a reverse request with the numeric id 0. If the supervisor
  // used numeric ids too, that request could be mistaken for the answer to one
  // of its own pending requests.
  await session.prompt("do something");
  await new Promise((resolve) => setTimeout(resolve, 300));

  const needsInput = events.find((event) => event.type === "needs_input");
  assert.ok(
    needsInput,
    "the agent's permission request must reach the supervisor instead of being swallowed",
  );

  const settled = events.find((event) => event.type === "settled");
  assert.equal(settled, undefined, "the turn must not settle while the permission is unanswered");

  await session.answer(
    (needsInput as { requestId: string }).requestId,
    { value: "Allow once" },
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  const responded = stderr.join("").includes("STUB_CLIENT_RESPONSE");
  assert.ok(responded, "the supervisor must answer the agent's reverse request");
  assert.ok(
    stderr.join("").includes('"optionId":"allow-once"'),
    "the answer must select the offered allow option",
  );

  const settledAfter = events.find((event) => event.type === "settled");
  assert.ok(settledAfter, "the turn settles after the permission is answered");
});

test("an agent request is never mistaken for the answer to a supervisor request", async (t) => {
  const { session, events } = await runAgainstStub(t);

  await session.prompt("do something");
  await new Promise((resolve) => setTimeout(resolve, 300));

  const needsInput = events.find((event) => event.type === "needs_input");
  assert.ok(needsInput, "the permission request must be delivered");
  assert.equal(
    events.find((event) => event.type === "settled"),
    undefined,
    "a pending turn must not be settled by an unrelated agent request",
  );

  await session.answer((needsInput as { requestId: string }).requestId, { value: "Deny" });
});

test("a permission request can be answered by its option id", async (t) => {
  const { session, events, stderr } = await runAgainstStub(t);

  await session.prompt("do something");
  await new Promise((resolve) => setTimeout(resolve, 300));

  const needsInput = events.find((event) => event.type === "needs_input") as
    | { requestId: string }
    | undefined;
  assert.ok(needsInput, "the permission request must be pending");

  // The supervisor only lets a client answer with the option label it showed,
  // but the adapter also accepts the raw option id.
  await session.answer(needsInput.requestId, { value: "allow-always" });
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.ok(
    stderr.join("").includes('"optionId":"allow-always"'),
    "the answer must select the offered always-allow option",
  );
});

test("a permission request the agent withdrew is dropped instead of waiting", async (t) => {
  const { session, events } = await runAgainstStub(t, { STUB_WITHDRAW_PERMISSION: "1" });

  await session.prompt("do something");
  await new Promise((resolve) => setTimeout(resolve, 400));

  const withdrawn = events.find(
    (event) => event.type === "progress" && (event as { kind?: string }).kind === "permission_withdrawn",
  );
  assert.ok(withdrawn, "the withdrawal must be reported");

  assert.equal(
    events.find((event) => event.type === "run_error"),
    undefined,
    "a withdrawn request is not an error",
  );
});

test("the agent's own verdict on a steering message is reported", async (t) => {
  const { session, events } = await runAgainstStub(t);

  await session.prompt("do something");
  await new Promise((resolve) => setTimeout(resolve, 200));

  await session.steer("stop the current command");
  await new Promise((resolve) => setTimeout(resolve, 200));

  const accepted = events.find(
    (event) => event.type === "progress" && (event as { kind?: string }).kind === "steer_accepted",
  ) as { detail?: string; preview?: string } | undefined;
  assert.ok(accepted, "the steering receipt must be reported");
  assert.equal(accepted.detail, "steered", "the agent's verdict must be kept verbatim");
  assert.equal(accepted.preview, "turn-stub-1", "the turn the agent joined must be recorded");
});

test("the agent's queue receipt for a follow-up is reported", async (t) => {
  const { session, events } = await runAgainstStub(t);

  await session.prompt("do something");
  await new Promise((resolve) => setTimeout(resolve, 200));

  await session.followUp("after the current turn");
  await new Promise((resolve) => setTimeout(resolve, 200));

  const queued = events.find(
    (event) => event.type === "progress" && (event as { kind?: string }).kind === "followup_queued",
  ) as { detail?: string; preview?: string } | undefined;
  assert.ok(queued, "the queue receipt must be reported");
  assert.equal(queued.detail, "queued @1", "the queue status and position must be kept");
  assert.equal(queued.preview, "queue-stub-1", "the queue item id must be recorded");
});

test("an extension request the supervisor does not model is still answered", async (t) => {
  const { session, stderr } = await runAgainstStub(t, { STUB_UNKNOWN_EXTENSION: "1" });

  await session.prompt("do something");
  await new Promise((resolve) => setTimeout(resolve, 400));

  const responses = stderr
    .join("")
    .split(/\r?\n/)
    .filter((line) => line.includes("STUB_CLIENT_RESPONSE"))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { id: unknown; errorCode?: number });
  const answered = responses.find((response) => response.id === 4242);
  assert.ok(answered, "the extension request must be answered");
  assert.equal(
    answered.errorCode,
    -32601,
    "an unmodelled extension request must be answered with method-not-found",
  );
});

test("a permission mode the agent refuses is reported instead of being ignored", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-mcode-stub-"));
  t.after(async () => {
    // The stub exits on its own; nothing to clean up beyond the temp dir.
  });

  await assert.rejects(
    McodeAcpSession.start({
      launch: {
        file: process.execPath,
        args: [STUB_ENTRY],
        description: "stub mcode acp",
        env: { ...process.env, STUB_CONFIG_ERROR: "1" },
      },
      args: [],
      cwd: dir,
      sessionDir: dir,
      permissionMode: "default",
      callbacks: {
        onEvent: () => undefined,
        onExit: () => undefined,
      },
      onStderr: () => undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SupervisorError, "the failure must be a supervisor error");
      assert.equal(
        error.code,
        "UNSUPPORTED",
        "a session that stays in bypassPermissions would act without asking",
      );
      return true;
    },
  );
});

test("steering outside an admitted turn is refused by the agent and reported", async (t) => {
  const { session, events } = await runAgainstStub(t);

  // The real agent refuses to steer unless a prompt turn is admitted. The
  // refusal has to reach the caller instead of looking like a success.
  await assert.rejects(
    session.steer("stop the current command"),
    (error: unknown) => {
      assert.ok(error instanceof SupervisorError, "the refusal must be reported as an error");
      assert.match(
        error.message,
        /Steering requires an admitted, active ACP prompt Turn/,
        "the agent's own message must be kept",
      );
      return true;
    },
  );
  assert.equal(
    events.find((event) => event.type === "progress" && (event as { kind?: string }).kind === "steer_accepted"),
    undefined,
    "a refused steer must not be reported as accepted",
  );

  // The same holds once the turn has ended.
  await session.prompt("do something");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const needsInput = events.find((event) => event.type === "needs_input") as
    | { requestId: string }
    | undefined;
  assert.ok(needsInput, "the turn must ask for permission");
  await session.answer(needsInput.requestId, { value: "Allow once" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(
    events.find((event) => event.type === "settled"),
    "the turn must settle before the steer is refused",
  );

  await assert.rejects(
    session.steer("stop the current command"),
    (error: unknown) => {
      assert.match(
        (error as Error).message,
        /Steering requires an admitted, active ACP prompt Turn/,
        "the agent's own message must be kept",
      );
      return true;
    },
  );
});

test("the same session can run a second turn and settle again", async (t) => {
  const { session, events } = await runAgainstStub(t);

  await session.prompt("first turn");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const needsInput = events.find((event) => event.type === "needs_input") as
    | { requestId: string }
    | undefined;
  assert.ok(needsInput, "the first turn must ask for permission");
  await session.answer(needsInput.requestId, { value: "Allow once" });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const settledAfterFirst = events.filter((event) => event.type === "settled");
  assert.equal(settledAfterFirst.length, 1, "the first turn must settle exactly once");

  await session.prompt("second turn");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const secondInput = events.filter((event) => event.type === "needs_input").at(-1) as
    | { requestId: string }
    | undefined;
  assert.ok(secondInput, "the second turn must ask for permission");
  await session.answer(secondInput.requestId, { value: "Allow once" });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const settledAfterSecond = events.filter((event) => event.type === "settled");
  assert.equal(
    settledAfterSecond.length,
    2,
    "a second turn on the same session must settle as well",
  );
});
