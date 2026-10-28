import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  encodeQoderProjectDir,
  expectedQoderSessionFile,
  qoderConfigRoots,
  resolveQoderLaunch,
  resolveQoderPermissionMode,
  sameQoderPermissionMode,
  sessionIdFromFile,
  validateQoderExtraArgs,
} from "../../src/adapters/qoder/launch.js";

test("Qoder launch strips desktop SDK entrypoint state and keeps the child standalone", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-launch-"));
  const entry = path.join(dir, "fake-qoder.js");
  await writeFile(entry, "", "utf8");
  const launch = resolveQoderLaunch({
    ...process.env,
    HARNESS_SUPERVISOR_QODER_ENTRY: entry,
    QODER_AGENT_SDK_ENTRYPOINT: "sdk-ts",
    QODER_AGENT_SDK_VERSION: "1.0.52",
    QODER_SDK_AUTH_PAYLOAD_FILE: "C:/stale/payload.json",
    QODER_WORKER_CWD: "C:/somewhere-else",
    QODERCN_SESSION_TYPE: "app",
  });
  assert.equal(launch.file, process.execPath);
  assert.equal(launch.args[0], entry);
  assert.equal(launch.env.QODER_AGENT_SDK_ENTRYPOINT, undefined);
  assert.equal(launch.env.QODER_AGENT_SDK_VERSION, undefined);
  assert.equal(launch.env.QODER_SDK_AUTH_PAYLOAD_FILE, undefined);
  assert.equal(launch.env.QODER_WORKER_CWD, undefined);
  assert.equal(launch.env.QODERCN_SESSION_TYPE, undefined);
});

test("Qoder permission mode defaults to bypass_permissions and explicit values win", () => {
  assert.equal(resolveQoderPermissionMode({}), "bypass_permissions");
  assert.equal(
    resolveQoderPermissionMode({
      HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: "bypass_permissions",
    }),
    "bypass_permissions",
  );
  assert.equal(
    resolveQoderPermissionMode({ HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: "yolo" }),
    "bypass_permissions",
    "the yolo alias maps to the supported full-permission value",
  );
  assert.equal(
    resolveQoderPermissionMode({ HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: "auto" }),
    "auto",
    "an explicit mode must not be replaced by the default",
  );
  assert.equal(
    resolveQoderPermissionMode({ HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: "dont_ask" }),
    "dont_ask",
  );
  assert.equal(
    resolveQoderPermissionMode({ HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: "accept_edits" }),
    "accept_edits",
    "legacy values stay available for older CLI builds",
  );
  assert.throws(
    () => resolveQoderPermissionMode({ HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: "sometimes" }),
    /Unsupported Qoder permission mode.*default: bypass_permissions/,
  );
});

test("Qoder compares snake_case flags with camelCase init reports", () => {
  assert.equal(sameQoderPermissionMode("bypass_permissions", "bypassPermissions"), true);
  assert.equal(sameQoderPermissionMode("dont_ask", "dontAsk"), true);
  assert.equal(sameQoderPermissionMode("accept_edits", "acceptEdits"), true);
  assert.equal(sameQoderPermissionMode("bypass_permissions", "auto"), false);
});

test("Qoder extraArgs cannot override supervisor-managed or safety-sensitive flags", () => {
  assert.throws(() => validateQoderExtraArgs(["--dangerously-skip-permissions"]), /may not override/);
  assert.throws(() => validateQoderExtraArgs(["--permission-mode=auto"]), /may not override/);
  assert.throws(() => validateQoderExtraArgs(["--resume", "abc"]), /may not override/);
  assert.throws(() => validateQoderExtraArgs(["--cwd", "D:/elsewhere"]), /may not override/);
  assert.throws(() => validateQoderExtraArgs(["--settings", "{}"]), /may not override/);
  assert.throws(() => validateQoderExtraArgs(["--remote-control", "x"]), /may not override/);
  assert.doesNotThrow(() => validateQoderExtraArgs(["--add-dir", "D:/work"]));
});

test("Qoder config roots prefer QODER_CONFIG_DIR over QODERCN_CONFIG_DIR", async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-root-a-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-root-b-"));
  const roots = qoderConfigRoots({
    QODER_CONFIG_DIR: first,
    QODERCN_CONFIG_DIR: second,
  });
  assert.equal(roots[0], path.resolve(first));
  assert.equal(roots[1], path.resolve(second));
});

test("Qoder session paths are derived from the project directory and session id", () => {
  assert.equal(encodeQoderProjectDir("D:\\Projects\\Harness-Supervisor"), "D--Projects-Harness-Supervisor");
  const id = "01a1618f-451f-75eb-9202-3dc4a55cd51e";
  assert.equal(sessionIdFromFile(`C:/q/.qoder/projects/x/${id}.jsonl`), id);
  assert.equal(sessionIdFromFile("C:/q/.qoder/projects/x/not-a-session.jsonl"), null);
  assert.equal(
    expectedQoderSessionFile("C:/q", "D:\\work", id),
    path.join("C:/q", "projects", "D--work", `${id}.jsonl`),
  );
});
