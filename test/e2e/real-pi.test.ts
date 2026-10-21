import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  TestDaemon,
  makeWorkspace,
  spawnWorker,
  waitTerminalLong,
} from "../integration/helpers.js";

const RUN_REAL_PI = process.env.RUN_REAL_PI === "1";
const MODEL = process.env.REAL_PI_MODEL ?? "deepseek-v4.1-flash-1017";
const PROVIDER = process.env.REAL_PI_PROVIDER ?? "new-api";

test(
  "REAL Pi worker executes a task in its own working directory",
  {
    skip: RUN_REAL_PI
      ? false
      : "Set RUN_REAL_PI=1 to run this paid, real-model integration test.",
    timeout: 240_000,
  },
  async (t) => {
    const daemon = await TestDaemon.create("hs-real-");
    const cwd = await makeWorkspace("hs-real-work-");
    t.after(async () => {
      await daemon.stop().catch(() => undefined);
    });
    const client = await daemon.start({ fakeHarness: false, readyTimeoutMs: 20_000 });
    const worker = await spawnWorker(
      client,
      cwd,
      [
        "Perform this one task now:",
        "1. In the current working directory, create a file named worker-output.txt using the write tool.",
        "2. Put exactly SUPERVISOR_E2E_OK (with a trailing newline) in that file.",
        "3. Do not read, create, edit, or run anything outside the current working directory.",
        "4. When done, reply with exactly: WORKER_DONE",
        "Do not ask for confirmation.",
      ].join("\n"),
      {
        model: MODEL,
        provider: PROVIDER,
        thinking: "off",
        tools: ["read", "bash", "write"],
        extraArgs: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"],
        maxDurationMs: 150_000,
      },
    );
    assert.equal(worker.status, "running");
    console.log(`REAL_PI worker=${worker.id} pid=${worker.pid} session=${worker.sessionFile}`);

    const final = await waitTerminalLong(client, worker.id, 180_000);
    if (final.worker.status !== "completed") {
      const status = await client.request<{ stderrTail: string }>("status", {
        workerId: worker.id,
        recentEvents: 30,
      });
      console.error("Real Pi run did not complete:", final.worker.status, final.worker.error);
      console.error("Harness stderr tail:\n", status.stderrTail);
    }
    assert.equal(final.worker.status, "completed", final.worker.error);
    assert.ok(final.worker.result?.text, "expected a final assistant result");
    const output = await readFile(path.join(cwd, "worker-output.txt"), "utf8");
    assert.equal(output.trim(), "SUPERVISOR_E2E_OK");
    console.log(
      `REAL_PI result=${JSON.stringify(final.worker.result?.text.slice(0, 500))} file=${path.join(cwd, "worker-output.txt")}`,
    );
  },
);
