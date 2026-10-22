#!/usr/bin/env node
// @ts-nocheck -- executable fixture for the notification delivery channel.
/**
 * Stands in for `codex queue --thread <id> --message <text>`.
 * Records argv to $HS_FAKE_CODEX_LOG so tests can assert exactly what was delivered.
 * Exits non-zero when $HS_FAKE_CODEX_FAIL=1 (delivery failure path).
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.HS_FAKE_CODEX_LOG;
if (log) {
  appendFileSync(log, `${JSON.stringify({ argv, at: new Date().toISOString() })}\n`, "utf8");
}
const sleepMs = Number(process.env.HS_FAKE_CODEX_SLEEP_MS || "0");
if (Number.isFinite(sleepMs) && sleepMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, sleepMs));
}
if (process.env.HS_FAKE_CODEX_FAIL === "1") {
  process.stderr.write("fake codex queue: simulated failure\n");
  process.exit(3);
}
const threadIndex = argv.indexOf("--thread");
const thread = threadIndex === -1 ? "unknown" : argv[threadIndex + 1];
process.stdout.write(`Queued message fake-${Date.now()} for thread ${thread}.\n`);