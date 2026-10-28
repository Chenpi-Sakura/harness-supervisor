import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveMcodeLaunch,
  resolveMcodePermissionMode,
  validateMcodeExtraArgs,
} from "../../src/adapters/mcode/launch.js";
import { readMcodeSessionHandle } from "../../src/adapters/mcode/adapter.js";

test("MiniMax Code launch uses the Node entry point instead of the npm shim", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-mcode-launch-"));
  const entry = path.join(dir, "cli.js");
  await writeFile(entry, "", "utf8");
  const launch = resolveMcodeLaunch({
    ...process.env,
    HARNESS_SUPERVISOR_MCODE_ENTRY: entry,
  });
  // Windows cannot spawn the npm `.cmd` shim directly, so the package entry
  // is launched through the current Node binary.
  assert.equal(launch.file, process.execPath);
  assert.equal(launch.args[0], entry);
  assert.equal(launch.args[1], "acp");
});

test("MiniMax Code launch rejects a missing explicit entry", () => {
  assert.throws(
    () =>
      resolveMcodeLaunch({
        HARNESS_SUPERVISOR_MCODE_ENTRY: path.join(os.tmpdir(), "does-not-exist-mcode.js"),
      } as NodeJS.ProcessEnv),
    /HARNESS_SUPERVISOR_MCODE_ENTRY does not exist/,
  );
});

test("MiniMax Code extraArgs cannot override supervisor-managed flags", () => {
  assert.throws(() => validateMcodeExtraArgs(["--permission"]), /may not override/);
  assert.throws(() => validateMcodeExtraArgs(["--cwd", "D:/elsewhere"]), /may not override/);
  assert.throws(() => validateMcodeExtraArgs(["--model", "x"]), /may not override/);
  assert.throws(() => validateMcodeExtraArgs(["--session", "x"]), /may not override/);
  assert.throws(() => validateMcodeExtraArgs(["exec"]), /may not override/);
  assert.throws(() => validateMcodeExtraArgs(["acp"]), /may not override/);
  assert.throws(() => validateMcodeExtraArgs(["a\0b"]), /without NUL bytes/);
  assert.doesNotThrow(() => validateMcodeExtraArgs(["--add-dir", "D:/work"]));
});

test("MiniMax Code permission mode defaults to bypassPermissions and explicit values win", () => {
  assert.equal(resolveMcodePermissionMode({}), "bypassPermissions");
  assert.equal(
    resolveMcodePermissionMode({ HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "bypassPermissions" }),
    "bypassPermissions",
  );
  assert.equal(
    resolveMcodePermissionMode({ HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "auto" }),
    "auto",
  );
  assert.equal(
    resolveMcodePermissionMode({ HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "default" }),
    "default",
    "Ask remains available when explicitly requested",
  );
  assert.throws(
    () =>
      resolveMcodePermissionMode({
        HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "yolo",
      }),
    /Unsupported MiniMax Code permission mode.*default: bypassPermissions/,
  );
});

test("MiniMax Code session handle carries the ACP session id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-mcode-handle-"));
  const file = path.join(dir, "mcode-session.json");
  await writeFile(
    file,
    `${JSON.stringify({ type: "session", id: "mvs_abc123", runtime: "mcode" })}\n`,
    "utf8",
  );
  assert.equal(await readMcodeSessionHandle(file), "mvs_abc123");
});

test("MiniMax Code session handle without a usable id is rejected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-mcode-handle-bad-"));
  const file = path.join(dir, "mcode-session.json");
  await writeFile(file, `${JSON.stringify({ type: "other", id: "x" })}\n`, "utf8");
  assert.equal(await readMcodeSessionHandle(file), null);
  await writeFile(file, "not json\n", "utf8");
  assert.equal(await readMcodeSessionHandle(file), null);
});
