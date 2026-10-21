#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const filter = process.argv[2];
const extraArgs = process.argv.slice(filter ? 3 : 2);

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".test.js")) files.push(full);
  }
  return files;
}

const all = await walk(path.join(root, "dist", "test"));
const files = filter
  ? all.filter((file) => file.includes(`${path.sep}${filter}${path.sep}`))
  : all;
if (files.length === 0) {
  console.error(`No test files found${filter ? ` for "${filter}"` : ""}. Run npm run build first.`);
  process.exit(1);
}
files.sort();
const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=1", ...extraArgs, ...files],
  { stdio: "inherit", windowsHide: true },
);
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
