import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Supervisor } from "../../src/supervisor.js";
import { Store } from "../../src/store.js";
import { Deferred } from "../../src/util/async.js";
import { silentLogger } from "../../src/util/logger.js";
import type { HarnessAdapter, HarnessCallbacks, HarnessSession } from "../../src/types.js";

for (const [operation, gateAt] of [["continue", "marker"], ["continue", "startup"], ["resume", "marker"]] as const) test(`prune cannot revoke admitted ${operation} (${gateAt})`, { timeout: 5000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-maintenance-admission-"));
  const sessionId = randomUUID(), sessionFile = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
  const entered = new Deferred<void>(), release = new Deferred<void>();
  const maintenance = new Deferred<void>(), releaseMaintenance = new Deferred<void>();
  let continuationCallbacks!: HarnessCallbacks;
  function session(callbacks: HarnessCallbacks, first: boolean): HarnessSession {
    let alive = true;
    return {
      pid: undefined, getState: async () => ({ sessionId, sessionFile }),
      prompt: async () => {
        callbacks.onEvent({ type: "run_started" });
        if (first) callbacks.onEvent({ type: "settled", aborted: false, finalText: "first" });
        return { disposition: "accepted" };
      },
      steer: async () => undefined, followUp: async () => undefined,
      clearQueue: async () => ({ steering: [], followUp: [] }), answer: async () => undefined,
      abort: async () => { callbacks.onEvent({ type: "settled", aborted: true, finalText: "" }); },
      close: async () => { alive = false; return { forced: false, exit: { code: 0, signal: null } }; },
      forceKill: async () => { alive = false; }, isAlive: () => alive, stderrTail: () => "",
    };
  }
  const adapter: HarnessAdapter = {
    name: "pi", capabilities: { runtime: "pi", cancel: true, steer: true, followUp: true, resume: true, pause: false, interactiveInput: true, idleContinue: "L3", notes: "controlled fixture" },
    spawn: async (_spec, callbacks) => session(callbacks, true),
    resume: async (_spec, _file, callbacks) => {
      continuationCallbacks = callbacks;
      if (gateAt === "startup") { entered.resolve(); await release.promise; }
      return session(callbacks, false);
    },
  };
  const supervisor = new Supervisor({ store: new Store(dir, silentLogger), stateDir: dir, supervisorId: "maintenance-admission", logger: silentLogger, adapters: new Map([["pi", adapter]]) });
  await supervisor.init();
  const flush = supervisor.idempotency.flush.bind(supervisor.idempotency);
  const prune = supervisor.retention.prune.bind(supervisor.retention);
  t.after(async () => { release.resolve(); releaseMaintenance.resolve(); supervisor.idempotency.flush = flush; supervisor.retention.prune = prune; await supervisor.shutdown(); });
  const worker = await supervisor.spawn({ cwd: dir, prompt: "first", persistence: operation === "continue" ? "persistent" : "oneshot" });
  await supervisor.wait(worker.id, { timeoutMs: 3000 });
  const inbox = supervisor.notifications({ workerId: worker.id, state: "all" });
  await supervisor.ackNotifications(inbox.notifications.map(item => item.id));
  let held = false;
  if (gateAt === "marker") supervisor.idempotency.flush = async () => {
    if (!held) { held = true; entered.resolve(); await release.promise; }
    await flush();
  };
  const continuing = supervisor[operation](worker.id, { prompt: "continue" }, { requestId: `gate-${gateAt}` });
  void continuing.catch(() => undefined); // Keep a baseline rejection observable without an unhandled promise.
  await entered.promise;
  await assert.rejects(supervisor.admin(worker.id, "retire"), /continue or resume/);
  supervisor.retention.prune = async options => {
    assert.ok(options?.protectedWorkerIds?.has(worker.id));
    maintenance.resolve();
    await releaseMaintenance.promise;
    return prune(options);
  };
  const pruning = supervisor.prune({ olderThanDays: 0, keep: 0 });
  void pruning.catch(() => undefined);
  await maintenance.promise;
  if (operation === "resume") {
    // Unlike persistent workers, this terminal oneshot is a real prune candidate.
    // Run maintenance while its admitted request is still waiting on disk I/O.
    releaseMaintenance.resolve();
    assert.equal((await pruning).removed.includes(worker.id), false);
  }
  release.resolve();
  const accepted = await continuing;
  assert.equal(accepted.status, "running");
  if (operation === "continue") await assert.rejects(supervisor.spawn({ cwd: dir, prompt: "not admitted" }), /Maintenance/);
  releaseMaintenance.resolve();
  assert.equal((await pruning).removed.includes(worker.id), false);
  continuationCallbacks.onEvent({ type: "settled", aborted: false, finalText: "continued" });
  assert.equal((await supervisor.wait(worker.id, { sinceSeq: accepted.lastSeq, timeoutMs: 3000 })).worker.result?.text, "continued");
});
