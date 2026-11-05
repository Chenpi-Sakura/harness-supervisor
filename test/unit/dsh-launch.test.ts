import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveDshLaunch,
  resolveDshPermissionMode,
  validateDshExtraArgs,
} from "../../src/adapters/dsh/launch.js";
import {
  mapDshThinking,
  resolveDshModelValue,
  resolveDshReasoningValue,
  type DshConfigOption,
} from "../../src/adapters/dsh/config.js";
import { readDshSessionHandle } from "../../src/adapters/dsh/session.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

const CONFIG_OPTIONS: DshConfigOption[] = [
  {
    id: "model",
    currentValue: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]),
    options: [
      {
        options: [
          {
            value: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]),
            name: "deepseek-v4-flash",
          },
          {
            value: JSON.stringify(["deepseek-official", "deepseek-flash"]),
            name: "DeepSeek-V4.1-Flash",
          },
        ],
      },
      {
        options: [
          {
            value: JSON.stringify(["deepseek-account", "deepseek-flash"]),
            name: "DeepSeek-V4.1-Flash",
          },
        ],
      },
    ],
  },
  {
    id: "reasoning_effort",
    currentValue: "high",
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

test("DSH explicit JS entry launches node with the acp profile", async () => {
  const dir = await tempDir("hs-dsh-launch-");
  const entry = path.join(dir, "cli.js");
  await writeFile(entry, "// fake\n", "utf8");
  const launch = resolveDshLaunch({ HARNESS_SUPERVISOR_DSH_ENTRY: entry });
  assert.equal(launch.file, process.execPath);
  assert.deepEqual(launch.args, [entry, "--profile", "acp"]);
});

test("DSH explicit entry must exist", () => {
  assert.throws(
    () => resolveDshLaunch({ HARNESS_SUPERVISOR_DSH_ENTRY: "C:/does/not/exist/dsh.cmd" }),
    /does not exist/,
  );
});

test("DSH desktop launcher uses the bundled Electron CLI without a shell", async () => {
  const root = await tempDir("hs-dsh-desktop-");
  const launcher = path.join(root, "resources", "runtime", "cli", "bin", "dsh.cmd");
  const exe = path.join(root, "DeepSeek Harness.exe");
  const asar = path.join(root, "resources", "app.asar");
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(launcher, "@echo off\r\n", "utf8");
  await writeFile(exe, "fake exe", "utf8");
  await writeFile(asar, "fake asar", "utf8");

  const launch = resolveDshLaunch({ HARNESS_SUPERVISOR_DSH_ENTRY: launcher });
  assert.equal(launch.file, exe);
  assert.deepEqual(launch.args, [
    "--expose-internals",
    path.join(
      root,
      "resources",
      "app.asar",
      "dsh",
      "node_modules",
      "@deepseek-ai",
      "dsh-desktop-host",
      "lib",
      "cli.js",
    ),
    "--profile",
    "acp",
  ]);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, "1");
});

test(
  "DSH cmd shim fallback keeps a path with spaces in one argument",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = await tempDir("hs dsh cmd-");
    const entry = path.join(dir, "dsh.cmd");
    await writeFile(entry, "@echo off\r\necho ARGS %*\r\n", "utf8");
    const launch = resolveDshLaunch({ HARNESS_SUPERVISOR_DSH_ENTRY: entry });
    assert.equal(launch.windowsVerbatimArguments, true);
    const result = spawnSync(launch.file, launch.args, {
      encoding: "utf8",
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ARGS --profile acp/);
  },
);

test("DSH extraArgs are rejected because the acp profile is fixed", () => {
  assert.throws(() => validateDshExtraArgs(["--patch", "extra.yml"]), /do not accept extraArgs/);
  assert.doesNotThrow(() => validateDshExtraArgs(undefined));
  assert.doesNotThrow(() => validateDshExtraArgs([]));
});

test("DSH permission mode defaults to the native workspace-write preset", () => {
  assert.equal(resolveDshPermissionMode({}), "workspace-write");
  assert.equal(
    resolveDshPermissionMode({ HARNESS_SUPERVISOR_DSH_PERMISSION_MODE: "danger-full-access" }),
    "danger-full-access",
  );
  assert.equal(
    resolveDshPermissionMode({ HARNESS_SUPERVISOR_DSH_PERMISSION_MODE: "full" }),
    "danger-full-access",
  );
  assert.equal(
    resolveDshPermissionMode({ DSH_PERMISSION_MODE: "read-only" }),
    "read-only",
  );
  assert.equal(
    resolveDshPermissionMode({
      DSH_PERMISSION_MODE: "read-only",
      HARNESS_SUPERVISOR_DSH_PERMISSION_MODE: "workspace-write",
    }),
    "workspace-write",
    "the HS-specific variable wins over the inherited native value",
  );
  assert.throws(
    () => resolveDshPermissionMode({ HARNESS_SUPERVISOR_DSH_PERMISSION_MODE: "ask" }),
    /Unsupported DSH permission mode/,
  );
});

test("DSH thinking levels fold to the four reasoning_effort values", () => {
  assert.equal(mapDshThinking("off"), "off");
  assert.equal(mapDshThinking("minimal"), "low");
  assert.equal(mapDshThinking("low"), "low");
  assert.equal(mapDshThinking("medium"), "high");
  assert.equal(mapDshThinking("high"), "high");
  assert.equal(mapDshThinking("xhigh"), "max");
  assert.equal(mapDshThinking("max"), "max");
});

test("DSH model selection uses provider/model pairs and refuses ambiguity", () => {
  assert.equal(
    resolveDshModelValue(CONFIG_OPTIONS, {
      provider: "deepseek-official",
      model: "deepseek-flash",
    }),
    JSON.stringify(["deepseek-official", "deepseek-flash"]),
  );
  assert.equal(
    resolveDshModelValue(CONFIG_OPTIONS, { model: "deepseek-v4-flash" }),
    JSON.stringify(["deepseek-official", "deepseek-v4-flash"]),
  );
  assert.throws(
    () => resolveDshModelValue(CONFIG_OPTIONS, { model: "DeepSeek-V4.1-Flash" }),
    /more than one provider/,
  );
  assert.throws(
    () => resolveDshModelValue(CONFIG_OPTIONS, { model: "missing-model" }),
    /does not offer model/,
  );
  assert.throws(
    () => resolveDshModelValue(CONFIG_OPTIONS, { provider: "deepseek-official" }),
    /needs both provider and model/,
  );
  assert.equal(resolveDshModelValue(CONFIG_OPTIONS, {}), undefined);
});

test("DSH reasoning_effort is verified against the advertised values", () => {
  assert.equal(resolveDshReasoningValue(CONFIG_OPTIONS, "max"), "max");
  assert.equal(resolveDshReasoningValue(CONFIG_OPTIONS, undefined), undefined);
  assert.throws(
    () => resolveDshReasoningValue([], "high"),
    /did not advertise a reasoning_effort/,
  );
});

test("DSH session handles are distinguishable from other ACP runtimes", () => {
  assert.equal(
    readDshSessionHandle(
      `${JSON.stringify({ type: "session", id: "dsh-1", runtime: "dsh", protocol: "acp" })}\n`,
    ),
    "dsh-1",
  );
  assert.equal(
    readDshSessionHandle(
      `${JSON.stringify({ type: "session", id: "mcode-1", runtime: "mcode" })}\n`,
    ),
    null,
  );
  assert.equal(readDshSessionHandle("not json\n"), null);
});
