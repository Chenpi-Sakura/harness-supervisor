#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import path from "node:path";
import { runDaemon } from "./daemon.js";
import { errorMessage } from "./errors.js";
import { resolveStateDir } from "./ipc/protocol.js";
import { redactText } from "./util/redact.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const stateDir = argValue("--state-dir");
const foreground = process.argv.includes("--foreground");

runDaemon({ stateDir, foreground })
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = errorMessage(error);
    process.stderr.write(`harness-supervisor daemon failed: ${message}\n`);
    // The async logger queue may not have flushed when startup throws. Write
    // one synchronous line so every failed start leaves evidence in daemon.log.
    try {
      appendFileSync(
        path.join(resolveStateDir(stateDir), "daemon.log"),
        `${new Date().toISOString()} ERROR Supervisor daemon startup failed ${JSON.stringify({ pid: process.pid, stage: "daemon_entry", error: redactText(message) })}\n`,
      );
    } catch {
      // Stderr above remains the fallback when the log is not writable.
    }
    process.exit(1);
  });
