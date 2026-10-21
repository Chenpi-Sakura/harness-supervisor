#!/usr/bin/env node
import { runDaemon } from "./daemon.js";
import { errorMessage } from "./errors.js";

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
    process.stderr.write(`harness-supervisor daemon failed: ${errorMessage(error)}\n`);
    process.exit(1);
  });
