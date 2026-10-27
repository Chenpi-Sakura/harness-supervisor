import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CLI_ENTRY, FAKE_ENTRY, makeWorkspace } from "./helpers.js";

const exec = promisify(execFile);

async function cli(args: string[], env: NodeJS.ProcessEnv, timeout = 60_000): Promise<string> {
  const result = await exec(process.execPath, [CLI_ENTRY, ...args], {
    env,
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

test("CLI creates tasks, records parent usage and exports machine-readable metrics", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-metrics-cli-"));
  const cwd = await makeWorkspace("hs-metrics-cli-work-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_SUPERVISOR_HOME: stateDir,
    HARNESS_SUPERVISOR_PI_ENTRY: FAKE_ENTRY,
    FAKE_PI_STEP_MS: "20",
  };
  t.after(async () => {
    await cli(["down", "--json"], env, 20_000).catch(() => undefined);
  });

  const spawned = JSON.parse(
    await cli(
      [
        "spawn",
        "--cwd",
        cwd,
        "--prompt",
        "CLI metrics worker",
        "--name",
        "cli metrics worker",
        "--wait",
        "--json",
      ],
      env,
    ),
  ) as { worker: { id: string; taskId?: string; status: string } };
  assert.equal(spawned.worker.status, "completed");
  assert.ok(spawned.worker.taskId);

  const shown = JSON.parse(
    await cli(["metrics", "show", spawned.worker.taskId!, "--json"], env),
  ) as {
    status: string;
    usage: Array<{ inputTokens: number | null; outputTokens: number | null }>;
    unknownFields: string[];
  };
  assert.equal(shown.status, "completed");
  assert.equal(shown.usage.length, 1);
  assert.equal(shown.usage[0]?.inputTokens, 10);
  assert.equal(shown.unknownFields.includes("cost"), true);

  const created = JSON.parse(
    await cli(["metrics", "create", "--title", "CLI explicit task", "--category", "coding", "--json"], env),
  ) as { id: string; title: string };
  assert.equal(created.title, "CLI explicit task");

  const usage = JSON.parse(
    await cli(
      [
        "metrics",
        "record-usage",
        created.id,
        "--role",
        "parent_agent",
        "--input-tokens",
        "42",
        "--output-tokens",
        "7",
        "--attribution",
        "incremental",
        "--usage-id",
        "cli-parent-1",
        "--json",
      ],
      env,
    ),
  ) as { id: string; attribution: string };
  assert.equal(usage.attribution, "incremental");

  const report = JSON.parse(
    await cli(["metrics", "report", "--include-tasks", "--json"], env),
  ) as {
    taskCount: number;
    knownParentUsage: { inputTokens: { value: number | null } };
    tasks: Array<{ task: { id: string } }>;
  };
  assert.equal(report.taskCount, 2);
  assert.equal(report.knownParentUsage.inputTokens.value, 42);
  assert.equal(report.tasks.length, 2);

  const exported = JSON.parse(await cli(["metrics", "export"], env)) as {
    taskCount: number;
    tasks: Array<{ task: { id: string } }>;
  };
  assert.equal(exported.taskCount, 2);
  assert.equal(exported.tasks.length, 2);

  const human = await cli(["metrics", "report"], env);
  assert.match(human, /tasks=2/);
  assert.match(human, /known worker usage/);
});
