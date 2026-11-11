import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SupervisorClient } from "../../src/ipc/client.js";
import type { NotificationsResult, WorkerSummary } from "../../src/types.js";
import { MCP_ENTRY, TestDaemon, makeWorkspace, spawnWorker, statusOf, waitTerminal } from "./helpers.js";

test("fixed IPC owner scope isolates operations, retries, inbox and ACK batches", async (t) => {
  const daemon = await TestDaemon.create("hs-owner-");
  t.after(() => daemon.stop());
  const global = await daemon.start();
  const cwd = await makeWorkspace();
  await global.request("notification_target", { channel: "codex-queue", codexThreadId: "shared-codex-thread" });
  const a = new SupervisorClient({ stateDir: daemon.stateDir, autoStart: false, scope: { ownerRef: "dsh:session-a", notifyNone: true } });
  const b = new SupervisorClient({ stateDir: daemon.stateDir, autoStart: false, scope: { ownerRef: "dsh:session-b", notifyNone: true } });
  t.after(() => { a.close(); b.close(); });
  const [wa, wb] = await Promise.all([
    spawnWorker(a, cwd, "[scenario:report] scoped", { requestId: "same-key", persistence: "persistent", ownerRef: "spoofed", notifyTarget: { channel: "codex-queue", codexThreadId: "spoofed-target" } }),
    spawnWorker(b, cwd, "[scenario:report] scoped", { requestId: "same-key" }),
  ]);
  assert.notEqual(wa.id, wb.id, "identical retry keys from different Masters must not alias");
  assert.equal(wa.ownerRef, "dsh:session-a");
  assert.deepEqual(wa.notifyTarget, { channel: "none" });
  assert.deepEqual(wb.notifyTarget, { channel: "none" });
  const legacy = await spawnWorker(global, cwd, "[scenario:report] unowned", { notifyTarget: { channel: "none" } });
  await Promise.all([waitTerminal(a, wa.id), waitTerminal(b, wb.id), waitTerminal(global, legacy.id)]);
  const replay = await spawnWorker(a, cwd, "[scenario:report] scoped", { requestId: "same-key", persistence: "persistent", ownerRef: "ignored", notifyTarget: { channel: "none" } });
  assert.equal(replay.id, wa.id);
  const listed = await a.request<WorkerSummary[]>("list", { ownerRef: "dsh:session-b" });
  assert.deepEqual(listed.map((w) => w.id), [wa.id]);
  for (const workerId of [wb.id, legacy.id]) {
    for (const method of ["status", "events", "wait", "cancel", "forget"] as const) {
      await assert.rejects(a.request(method, { workerId }), { code: "UNAUTHORIZED" });
    }
    await assert.rejects(a.request("continue", { workerId, prompt: "cross session" }), { code: "UNAUTHORIZED" });
    await assert.rejects(a.request("resume", { workerId, prompt: "cross session" }), { code: "UNAUTHORIZED" });
    await assert.rejects(a.request("send", { workerId, message: "cross session" }), { code: "UNAUTHORIZED" });
  }
  for (const method of ["shutdown", "notification_target_get", "ui_stop", "runtime_update_status", "prune"] as const) {
    await assert.rejects(a.request(method, {}), { code: "UNAUTHORIZED" });
  }
  const inboxA = await a.request<NotificationsResult>("notifications", { state: "all" });
  const inboxB = await b.request<NotificationsResult>("notifications", { state: "all" });
  assert.equal(inboxA.notifications.length, 1);
  assert.equal(inboxA.globalCounts?.unacked, 1, "scoped counts must not reveal global inbox");
  const ownId = inboxA.notifications[0]!.id;
  const otherId = inboxB.notifications[0]!.id;
  await assert.rejects(a.request("notification_ack", { ids: [ownId, otherId] }), { code: "UNAUTHORIZED" });
  const unchanged = await a.request<NotificationsResult>("notifications", { state: "all" });
  assert.equal(unchanged.notifications[0]?.ackAt, undefined, "reject whole ACK batch before any mutation");
  await a.request("notification_ack", { ids: [ownId] });
  const sessionId = (await statusOf(a, wa.id)).worker.sessionId;
  const continued = await a.request<WorkerSummary>("continue", { workerId: wa.id, prompt: "[scenario:report] next", notifyTarget: { channel: "codex-queue", codexThreadId: "ignored-target" } });
  const final = await waitTerminal(a, wa.id, 30_000, continued.lastSeq);
  assert.equal(final.worker.ownerRef, wa.ownerRef);
  assert.equal(final.worker.sessionId, sessionId);
  assert.deepEqual(final.worker.notifyTarget, { channel: "none" });
});

test("scoped MCP catalogs omit global controls and fixed process context wins over caller metadata", async (t) => {
  const daemon = await TestDaemon.create("hs-owner-mcp-");
  t.after(() => daemon.stop());
  const global = await daemon.start();
  const cwd = await makeWorkspace();
  await global.request("notification_target", { channel: "codex-queue", codexThreadId: "global-codex-thread" });
  const transports = ["a", "b"].map((id) => new StdioClientTransport({ command: process.execPath, args: [MCP_ENTRY, "--state-dir", daemon.stateDir, "--owner-ref", `dsh:${id}`, "--notify-none"], stderr: "pipe" }));
  const clients = transports.map(() => new Client({ name: "scope-test", version: "1" }));
  t.after(async () => { await Promise.all(clients.map((c) => c.close().catch(() => undefined))); });
  await Promise.all(clients.map((c, i) => c.connect(transports[i]!)));
  const catalog = await clients[0]!.listTools();
  assert.ok(catalog.tools.some((tool) => tool.name === "worker_continue"));
  assert.ok(catalog.tools.every((tool) => !tool.name.startsWith("metrics_") && tool.name !== "supervisor_wake_target"));
  const spawned = await Promise.all(clients.map(async (c) => {
    const result = await c.callTool({ name: "worker_spawn", arguments: { cwd, prompt: "[scenario:report] MCP", requestId: "same" }, _meta: { threadId: "01a181c6-823f-7fe0-92b9-b8cf38c5bb41" } });
    assert.notEqual(result.isError, true);
    return JSON.parse((result.content as Array<{text: string}>)[0]!.text) as WorkerSummary;
  }));
  assert.notEqual(spawned[0]!.id, spawned[1]!.id);
  for (const worker of spawned) {
    const stored = (await statusOf(global, worker.id)).worker;
    assert.match(stored.ownerRef!, /^dsh:[ab]$/);
    assert.deepEqual(stored.notifyTarget, { channel: "none" });
    await waitTerminal(global, worker.id);
  }
  const cross = await clients[0]!.callTool({ name: "worker_status", arguments: { workerId: spawned[1]!.id } });
  assert.equal(cross.isError, true);
});
