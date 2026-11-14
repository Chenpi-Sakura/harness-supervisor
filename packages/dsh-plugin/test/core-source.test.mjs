import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findGlobalCore, validateCoreRoot } from "../src/core-source.js";

test("npm selection discovers a global package without a shell and validates its build", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-core-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = path.join(dir, "npm-cli.js");
  await writeFile(cli, "");
  const root = path.join(dir, "global/harness-supervisor");
  await mkdir(path.join(root, "dist/src"), { recursive: true });
  await mkdir(path.join(root, "dist/web"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "harness-supervisor" }));
  for (const file of ["dist/src/daemon-entry.js", "dist/src/mcp.js", "dist/web/index.html"]) await writeFile(path.join(root, file), "");
  assert.equal(findGlobalCore(process.execPath, { npm_execpath: cli }, (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [cli, "root", "--global"]);
    assert.equal(options.shell, undefined);
    return path.join(dir, "global") + "\n";
  }), root);
  assert.throws(() => validateCoreRoot("relative"), /绝对路径/);
  await rm(path.join(root, "dist/src/mcp.js"));
  assert.throws(() => validateCoreRoot(root), /安装不完整/);
  assert.throws(() => findGlobalCore(process.execPath, { npm_execpath: cli }, () => dir), /npm install -g harness-supervisor/);
});
