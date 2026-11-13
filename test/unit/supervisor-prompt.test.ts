import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/store.js";
import { Supervisor } from "../../src/supervisor.js";
import { createLogger } from "../../src/util/logger.js";
import type { HarnessAdapter, HarnessCallbacks, HarnessSession } from "../../src/types.js";

test("an accepted prompt is retained when the harness completes before prompt returns, including continuation", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-fast-prompt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = path.join(dir, "native-session.json");
  await writeFile(sessionFile, "{}");
  const store = new Store(dir);
  const session = (callbacks: HarnessCallbacks, workerId: string): HarnessSession => ({
    pid: undefined,
    getState: async () => ({ sessionId: "native-session", sessionFile }),
    prompt: async () => {
      callbacks.onEvent({ type: "run_started" });
      callbacks.onEvent({ type: "settled", aborted: false, finalText: "DONE" });
      const deadline = Date.now() + 5000;
      while (store.getWorker(workerId)?.status !== "completed") {
        if (Date.now() > deadline) throw Error("Terminal event was not processed");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return { disposition: "accepted" };
    },
    steer: async () => {}, followUp: async () => {},
    clearQueue: async () => ({ steering: [], followUp: [] }),
    abort: async () => {}, answer: async () => {},
    close: async () => ({ exit: null, forced: false }), forceKill: async () => {},
    isAlive: () => true, stderrTail: () => "",
  });
  const adapter: HarnessAdapter = {
    name: "pi",
    capabilities: { runtime: "pi", steer: true, followUp: true, cancel: true, resume: true, pause: false, interactiveInput: true, notes: "synthetic" },
    spawn: async (spec, callbacks) => session(callbacks, spec.workerId),
    resume: async (spec, _file, callbacks) => session(callbacks, spec.workerId),
  };
  const supervisor = new Supervisor({ store, stateDir: dir, supervisorId: "prompt-test", logger: createLogger(null), adapters: new Map([["pi", adapter]]) });
  await supervisor.init();
  t.after(() => supervisor.shutdown());
  const prompt = "# First\n\n" + "long instructions ".repeat(100);
  const worker = await supervisor.spawn({ cwd: dir, prompt, persistence: "persistent" });
  assert.equal(worker.status, "completed");
  assert.deepEqual(await store.readPrompt(worker.id), { text: prompt, available: true });
  const next = "# Next\n\n" + "different instructions ".repeat(100);
  await supervisor.continue(worker.id, { prompt: next });
  assert.deepEqual(await store.readPrompt(worker.id), { text: next, available: true });
});
