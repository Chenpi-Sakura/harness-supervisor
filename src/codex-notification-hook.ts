#!/usr/bin/env node
import { checkNotificationPrompt, parseNotificationPointer } from "./codex-notification-gate.js";

// This optional native UserPromptSubmit hook emits no model context on allow.
// It reads no IPC token, mutates no ACK and never launches/retries a worker.
let body = "";
let oversized = false;
try {
  for await (const chunk of process.stdin) {
    if (!oversized) body += String(chunk);
    if (Buffer.byteLength(body) > 64 * 1024) { oversized = true; body = ""; }
  }
  if (!oversized) {
    const input = JSON.parse(body);
    if (input?.hook_event_name !== "UserPromptSubmit" || !parseNotificationPointer(input.prompt)) process.exit(0);
    // Ordinary prompts avoid loading the IPC schema/runtime dependencies.
    const { resolveStateDir } = await import("./ipc/protocol.js");
    const index = process.argv.indexOf("--state-dir");
    if (index !== -1 && !process.argv[index + 1]) throw new Error("Missing state directory");
    const result = await checkNotificationPrompt(input, resolveStateDir(index === -1 ? undefined : process.argv[index + 1]));
    if (result.block) process.stdout.write(JSON.stringify({
      decision: "block", reason: `HS notification ${result.id} was already acknowledged.`,
    }) + "\n");
  }
} catch { /* Fail open: malformed/non-HS input or unavailable state is not a veto. */ }
