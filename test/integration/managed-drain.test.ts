import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Supervisor } from "../../src/supervisor.js";
import { Store } from "../../src/store.js";
import { Deferred, sleep } from "../../src/util/async.js";
import { silentLogger } from "../../src/util/logger.js";
import type { HarnessAdapter, HarnessCallbacks, HarnessSession } from "../../src/types.js";

test("drain counts admitted requests still awaiting their durable idempotency marker", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-drain-marker-"));
  const supervisor = new Supervisor({ store: new Store(dir, silentLogger), stateDir: dir, supervisorId: "drain-marker", logger: silentLogger, adapters: new Map() });
  await supervisor.init();
  const entered = new Deferred<void>(), release = new Deferred<void>();
  const flush = supervisor.idempotency.flush.bind(supervisor.idempotency);
  supervisor.idempotency.flush = async () => { entered.resolve(); await release.promise; await flush(); };
  t.after(async () => { release.resolve(); supervisor.idempotency.flush = flush; await supervisor.shutdown(); });
  const admitted = supervisor.spawn({ cwd: dir, prompt: "accepted before drain", runtime: "missing" }, { requestId: "held-marker" });
  // Attach the rejection handler before releasing the controlled marker.
  const result = assert.rejects(admitted, /Unknown runtime/);
  await entered.promise;
  supervisor.beginDrain("marker-race");
  assert.equal(supervisor.drainStatus().pendingAdmissions, 1);
  assert.equal(supervisor.drainStatus().ready, false);
  assert.throws(() => supervisor.sealDrain("marker-race"), /before quiescence/);
  release.resolve();
  await result;
  assert.equal(supervisor.drainStatus().pendingAdmissions, 0);
  assert.equal(supervisor.drainStatus().ready, true);
  supervisor.sealDrain("marker-race");
  await assert.rejects(() => supervisor.ackNotifications(["missing"]), /switching cores/);
});

test("drain permits accepted startup and human answer, waits for real finalization, blocks new work", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-drain-"));
  const entered = new Deferred<void>(), releaseStartup = new Deferred<void>(), releaseClose = new Deferred<void>();
  let callbacks!: HarnessCallbacks;
  let alive = true;
  const session: HarnessSession = {
    pid: undefined,
    getState: async () => ({}),
    prompt: async () => { callbacks.onEvent({ type: "run_started" }); callbacks.onEvent({ type: "needs_input", requestId: "native-1", method: "confirm", message: "Finish?" }); return { disposition: "accepted" }; },
    steer: async () => undefined, followUp: async () => undefined,
    clearQueue: async () => ({ steering: [], followUp: [] }), abort: async () => undefined,
    answer: async (id, response) => { assert.equal(id, "native-1"); assert.deepEqual(response, { confirmed: true }); callbacks.onEvent({ type: "settled", aborted: false, finalText: "finished" }); },
    close: async () => { await releaseClose.promise; alive = false; return { forced: false, exit: { code: 0, signal: null } }; },
    forceKill: async () => { alive = false; releaseClose.resolve(); },
    isAlive: () => alive, stderrTail: () => "",
  };
  const adapter: HarnessAdapter = {
    name: "pi", capabilities: { runtime: "pi", cancel: true, steer: true, followUp: true, resume: true, pause: false, interactiveInput: true, notes: "fixture" },
    spawn: async (_spec, cb) => { callbacks = cb; entered.resolve(); await releaseStartup.promise; return session; },
    resume: async () => session,
  };
  const supervisor = new Supervisor({ store: new Store(dir, silentLogger), stateDir: dir, supervisorId: "drain-test", logger: silentLogger, adapters: new Map([["pi", adapter]]) });
  await supervisor.init();
  t.after(async () => { releaseStartup.resolve(); releaseClose.resolve(); await supervisor.shutdown(); });
  const accepted = supervisor.spawn({ cwd: dir, prompt: "ask", persistence: "persistent" });
  await entered.promise;
  supervisor.beginDrain("update-one");
  assert.equal(supervisor.drainStatus().ready, false, "an accepted startup reservation blocks handoff");
  await assert.rejects(() => supervisor.spawn({ cwd: dir, prompt: "new" }), /draining/);
  releaseStartup.resolve();
  const worker = await accepted;
  for (let tries = 0; tries < 100 && !(await supervisor.status(worker.id)).worker.pendingInput; tries++) await sleep(10);
  const pending = (await supervisor.status(worker.id)).worker.pendingInput!;
  assert.ok(pending);
  await assert.rejects(() => supervisor.send(worker.id, "new follow-up", "follow-up"), /draining/);
  await assert.rejects(() => supervisor.resume(worker.id, { prompt: "resume" }), /draining/);
  await assert.rejects(() => supervisor.continue(worker.id, { prompt: "continue" }), /draining/);
  await supervisor.answer(worker.id, pending.requestId, { confirmed: true });
  assert.equal(supervisor.drainStatus().ready, false, "native close still in flight must block handoff");
  releaseClose.resolve();
  for (let tries = 0; tries < 100 && !supervisor.drainStatus().ready; tries++) await sleep(10);
  assert.equal(supervisor.drainStatus().ready, true);
  assert.equal((await supervisor.status(worker.id)).worker.result?.text, "finished");
  await supervisor.flushForHandoff();
  supervisor.cancelDrain("update-one");
  assert.equal(supervisor.drainStatus().intentId, null);
});
