#!/usr/bin/env node
// Opt-in real native/IPC verification. No product dependency or user configuration is installed here.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TestDaemon, waitTerminal, waitTerminalLong, waitPidDead } from "../dist/test/integration/helpers.js";

if (process.env.RUN_OPENCODE !== "1") {
  console.log("SKIP: run with RUN_OPENCODE=1; OpenCode v2 must already be installed and authenticated. REAL_OPENCODE_MODEL optionally selects an advertised provider/model.");
  process.exit(0);
}

const daemon = await TestDaemon.create("hs-opencode-real-");
const cwd = await mkdtemp(path.join(os.tmpdir(), "hs-opencode-work-"));
const codeA = randomUUID(), codeB = randomUUID();
const env = { HARNESS_SUPERVISOR_UI: "0", OPENCODE_DB: path.join(daemon.stateDir, "opencode.db"), OPENCODE_DISABLE_AUTOUPDATE: "1" };
let client;
const settled = async (worker) => {
  const result = await waitTerminalLong(client, worker.id, 180_000);
  assert.equal(result.worker.status, "completed", result.worker.error ?? result.worker.result?.text);
  return result.worker;
};

try {
  client = await daemon.start({ fakeHarness: false, env });
  let worker = await client.request("spawn", {
    runtime: "opencode", cwd, model: process.env.REAL_OPENCODE_MODEL, persistence: "persistent",
    prompt: `Remember the first codeword ${codeA} only in this conversation; never write the codeword into a file. Separately create proof.txt containing the three ASCII bytes one, with no newline or other content. Reply exactly TURN1_READY.`,
  }, { timeoutMs: 120_000 });
  worker = await settled(worker);
  assert.equal(await readFile(path.join(cwd, "proof.txt"), "utf8"), "one");
  const sessionId = worker.sessionId;
  assert.ok(sessionId);
  console.log(JSON.stringify({ turn: 1, status: worker.status, runtimeInfo: worker.runtimeInfo }));

  worker = await client.request("continue", {
    workerId: worker.id,
    prompt: `Remember the second codeword ${codeB} only in this conversation; never write it into a file. Replace proof.txt with the three ASCII bytes two, with no newline or other content. Reply exactly TURN2_READY.`,
  }, { timeoutMs: 120_000 });
  worker = await settled(worker);
  assert.equal(worker.sessionId, sessionId);
  assert.equal(await readFile(path.join(cwd, "proof.txt"), "utf8"), "two");
  console.log(JSON.stringify({ turn: 2, status: worker.status }));

  await daemon.stop();
  client = await daemon.start({ fakeHarness: false, env });
  worker = await client.request("resume", {
    workerId: worker.id,
    prompt: "Recall the two codewords from this conversation, without reading any other files. Replace proof.txt with the five ASCII bytes three, with no newline or other content. Reply with both earlier codewords separated by a comma.",
  }, { timeoutMs: 120_000 });
  worker = await settled(worker);
  assert.equal(worker.sessionId, sessionId);
  assert.equal(await readFile(path.join(cwd, "proof.txt"), "utf8"), "three");
  assert.ok(worker.result?.text.includes(codeA), "native session did not recall first codeword");
  assert.ok(worker.result?.text.includes(codeB), "native session did not recall second codeword");
  console.log(JSON.stringify({ turn: 3, restarted: true, status: worker.status, usage: worker.usage }));

  worker = await client.request("continue", { workerId: worker.id, prompt: "Use a shell to wait 30 seconds, then create cancelled.txt containing unexpected. Do not create it before waiting." }, { timeoutMs: 120_000 });
  const pid = worker.pid;
  await client.request("cancel", { workerId: worker.id }, { timeoutMs: 30_000 });
  const cancelled = await waitTerminal(client, worker.id, 30_000);
  assert.equal(cancelled.worker.status, "cancelled");
  if (pid) await waitPidDead(pid);
  await assert.rejects(readFile(path.join(cwd, "cancelled.txt")), { code: "ENOENT" });
  console.log(JSON.stringify({ ok: true, turns: 3, nativeRestart: true, cancellation: true, model: process.env.REAL_OPENCODE_MODEL ?? "native default" }));
} finally {
  await daemon.stop();
  for (const [directory, prefix] of [[cwd, "hs-opencode-work-"], [daemon.stateDir, "hs-opencode-real-"]]) {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith(prefix));
  }
  await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  await rm(daemon.stateDir, { recursive: true, force: true, maxRetries: 5 });
}
