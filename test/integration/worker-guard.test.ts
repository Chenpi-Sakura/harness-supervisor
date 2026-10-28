import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WORKER_PROTOCOL_MARKER } from "../../src/worker-protocol.js";
import {
  TestDaemon,
  eventsOf,
  makeWorkspace,
  spawnWorker,
  waitTerminal,
} from "./helpers.js";

async function fakeCodexDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-guard-int-bin-"));
  await writeFile(
    path.join(dir, "codex.cmd"),
    '@echo off\r\necho %* > "%~dp0args.txt"\r\necho FAKE_CODEX_OK\r\n',
  );
  const shell = path.join(dir, "codex");
  await writeFile(
    shell,
    '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$(dirname "$0")/args.txt"\necho FAKE_CODEX_OK\n',
  );
  await chmod(shell, 0o755);
  return dir;
}

test("worker command guard denies codex queue and forwards other commands", async (t) => {
  const fakeBin = await fakeCodexDir();
  const cwd = await makeWorkspace();
  const baseEnv = {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
  };

  const deniedDaemon = await TestDaemon.create("hs-guard-denied-");
  t.after(() => deniedDaemon.stop());
  await deniedDaemon.start({
    env: { ...baseEnv, FAKE_PI_EXEC: "codex queue --thread t-1 --message hi" },
  });
  const deniedWorker = await spawnWorker(
    deniedDaemon.client!,
    cwd,
    "[scenario:normal] guard deny",
  );
  const denied = await waitTerminal(deniedDaemon.client!, deniedWorker.id, 30_000);
  assert.equal(denied.worker.status, "completed", denied.worker.error);
  const deniedText = denied.worker.result?.text ?? "";
  assert.match(deniedText, /EXEC_FAIL:2/, "the shim exits with the denial code");
  assert.match(deniedText, /may not call `codex queue`/);
  assert.doesNotMatch(deniedText, /FAKE_CODEX_OK/, "the real CLI never runs for queue");

  const log = await readFile(
    path.join(deniedDaemon.stateDir, "worker-guard", "worker-guard.jsonl"),
    "utf8",
  );
  assert.match(log, /codex_queue_denied/);
  assert.ok(log.includes(deniedWorker.id), "the denial is attributable to the worker");

  // The protocol block is part of the task the native harness actually received.
  const events = await eventsOf(deniedDaemon.client!, deniedWorker.id);
  const sessionEvent = events.events.find((event) => event.type === "worker.session");
  const sessionFile = (sessionEvent?.data as { sessionFile?: string } | undefined)?.sessionFile;
  assert.ok(sessionFile, "the session file is recorded");
  const records = (await readFile(sessionFile!, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const userMessage = records.find((record) => record.message?.role === "user");
  assert.ok(userMessage, "the prompt was persisted");
  const prompt: string = userMessage.message.content;
  assert.ok(prompt.startsWith(WORKER_PROTOCOL_MARKER), "the worker protocol block is prepended");
  assert.ok(prompt.includes("[scenario:normal] guard deny"), "the original task is preserved");

  const allowedDaemon = await TestDaemon.create("hs-guard-allowed-");
  t.after(() => allowedDaemon.stop());
  await allowedDaemon.start({
    env: { ...baseEnv, FAKE_PI_EXEC: "codex --version" },
  });
  const allowedWorker = await spawnWorker(
    allowedDaemon.client!,
    cwd,
    "[scenario:normal] guard allow",
  );
  const allowed = await waitTerminal(allowedDaemon.client!, allowedWorker.id, 30_000);
  assert.equal(allowed.worker.status, "completed", allowed.worker.error);
  assert.match(allowed.worker.result?.text ?? "", /EXEC_OK:FAKE_CODEX_OK/);
  assert.match(
    await readFile(path.join(fakeBin, "args.txt"), "utf8"),
    /--version/,
    "the shim forwards other commands to the real CLI",
  );

  // A PATH shim is not a security boundary: an absolute path bypasses it. This
  // is asserted rather than only documented, so nobody mistakes the guard for
  // isolation in a later change.
  const bypassDaemon = await TestDaemon.create("hs-guard-bypass-");
  t.after(() => bypassDaemon.stop());
  const absolute =
    process.platform === "win32" ? path.join(fakeBin, "codex.cmd") : path.join(fakeBin, "codex");
  await bypassDaemon.start({
    env: { ...baseEnv, FAKE_PI_EXEC: `"${absolute}" queue --thread t-1 --message hi` },
  });
  const bypassWorker = await spawnWorker(
    bypassDaemon.client!,
    cwd,
    "[scenario:normal] guard bypass",
  );
  const bypass = await waitTerminal(bypassDaemon.client!, bypassWorker.id, 30_000);
  assert.equal(bypass.worker.status, "completed", bypass.worker.error);
  assert.match(
    bypass.worker.result?.text ?? "",
    /EXEC_OK:FAKE_CODEX_OK/,
    "an absolute path reaches the real CLI and bypasses the guard",
  );
  assert.equal(
    existsSync(path.join(bypassDaemon.stateDir, "worker-guard", "worker-guard.jsonl")),
    false,
    "a bypass leaves no denial record",
  );
});