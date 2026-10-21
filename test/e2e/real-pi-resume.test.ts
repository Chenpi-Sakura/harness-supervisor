import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PiAdapter } from "../../src/adapters/pi/adapter.js";
import type { HarnessEvent } from "../../src/types.js";

const RUN_REAL_PI = process.env.RUN_REAL_PI === "1";

test(
  "REAL Pi loads a persisted session through the adapter and retains its session id",
  {
    skip: RUN_REAL_PI
      ? false
      : "Set RUN_REAL_PI=1 to run this native-Pi session-loading test (it makes no model call).",
    timeout: 60_000,
  },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hs-pi-resume-"));
    const sessionDir = path.join(dir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const sessionId = randomUUID();
    const sessionFile = path.join(dir, "persisted-session.jsonl");
    const now = Date.now();
    const lines = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date(now).toISOString(),
        cwd: dir,
      },
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: new Date(now + 1).toISOString(),
        message: { role: "user", content: "previous task", timestamp: now + 1 },
      },
      {
        type: "message",
        id: "b2",
        parentId: "a1",
        timestamp: new Date(now + 2).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "previous answer" }],
          api: "openai-responses",
          provider: "new-api",
          model: "deepseek-v4.1-flash-1017",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: now + 2,
        },
      },
    ];
    await writeFile(
      sessionFile,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    const events: HarnessEvent[] = [];
    let exitSeen = false;
    const adapter = new PiAdapter();
    const session = await adapter.resume(
      {
        workerId: "w-real-resume-test",
        cwd: dir,
        sessionDir,
        extraArgs: [
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
        ],
      },
      sessionFile,
      {
        onEvent: (event) => events.push(event),
        onExit: () => {
          exitSeen = true;
        },
      },
    );
    try {
      const state = await session.getState();
      assert.equal(state.sessionId, sessionId);
      assert.equal(
        path.resolve(state.sessionFile ?? "").toLowerCase(),
        path.resolve(sessionFile).toLowerCase(),
      );
    } finally {
      await session.close({ graceMs: 2000 });
    }
    assert.equal(exitSeen, true);
    assert.equal(session.isAlive(), false);
  },
);
