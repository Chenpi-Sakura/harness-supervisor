import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { WorkerSummary } from "../../src/types.js";
import { TestDaemon, makeWorkspace, waitTerminal, waitForStatus } from "./helpers.js";

for (const runtime of ["codex", "claude"] as const) test(`${runtime} ACP integrates with daemon spawn, persistent continue, approval and cancel`, async t => {
  const daemon = await TestDaemon.create(`hs-${runtime}-acp-`);
  t.after(() => daemon.stop());
  const entry = fileURLToPath(new URL("../fixtures/fake-native-acp.js", import.meta.url));
  const client = await daemon.start({ env: { [`HARNESS_SUPERVISOR_${runtime.toUpperCase()}_ACP_ENTRY`]: entry, HARNESS_SUPERVISOR_WORKER_PROTOCOL: "0", HARNESS_SUPERVISOR_UI: "0" } });
  const cwd = await makeWorkspace();
  const worker = await client.request<WorkerSummary>("spawn", { runtime, cwd, prompt: "first", persistence: "persistent", model: "gpt-6-luna", thinking: "low" });
  const first = await waitTerminal(client, worker.id);
  assert.equal(first.worker.result?.text, "DONE first");
  await client.request("continue", { workerId: worker.id, prompt: "approve" });
  const input = await waitForStatus(client, worker.id, ["awaiting_input"]);
  assert.ok(input.pendingInput);
  await client.request("answer", { workerId: worker.id, requestId: input.pendingInput.requestId, response: { value: "Allow once" } });
  const second = await waitTerminal(client, worker.id);
  assert.equal(second.worker.result?.text, "ALLOWED");
  await client.request("continue", { workerId: worker.id, prompt: "slow" });
  await client.request("cancel", { workerId: worker.id });
  assert.equal((await waitTerminal(client, worker.id)).worker.status, "cancelled");
});
