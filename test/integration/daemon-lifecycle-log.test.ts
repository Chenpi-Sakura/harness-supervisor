import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isPidAlive } from "../../src/util/async.js";
import {
  DAEMON_ENTRY,
  TestDaemon,
  eventsOf,
  makeWorkspace,
  spawnWorker,
  statusOf,
  waitForStatus,
} from "./helpers.js";

async function readLog(stateDir: string): Promise<string> {
  return readFile(path.join(stateDir, "daemon.log"), "utf8").catch(() => "");
}

interface LogLine {
  time?: string;
  level?: string;
  message?: string;
  data?: Record<string, unknown>;
}

function lines(raw: string): LogLine[] {
  const parsed: LogLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\S+ (?:DEBUG|INFO|WARN|ERROR) (.*)$/.exec(line);
    if (!match) continue;
    const rest = match[1] ?? "";
    const brace = rest.indexOf(" {");
    if (brace < 0) {
      parsed.push({ message: rest });
      continue;
    }
    try {
      parsed.push({
        message: rest.slice(0, brace),
        data: JSON.parse(rest.slice(brace + 1)) as Record<string, unknown>,
      });
    } catch {
      parsed.push({ message: rest });
    }
  }
  return parsed;
}

function entry(raw: string, message: string): LogLine | undefined {
  return lines(raw).find((line) => line.message === message);
}

function lastEntry(raw: string, message: string): LogLine | undefined {
  return lines(raw).filter((line) => line.message === message).at(-1);
}

async function waitForLastEntry(
  stateDir: string,
  message: string,
  predicate: (line: LogLine) => boolean,
  timeoutMs = 5000,
): Promise<LogLine> {
  const deadline = Date.now() + timeoutMs;
  let last: LogLine | undefined;
  while (Date.now() < deadline) {
    last = lastEntry(await readLog(stateDir), message);
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${message}: ${JSON.stringify(last)}`);
}

test("daemon lifecycle logs correlate start, stop and the next instance", async (t) => {
  const daemon = await TestDaemon.create("hs-lifecycle-log-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const client = await daemon.start();
  const endpoint = JSON.parse(
    await readFile(path.join(daemon.stateDir, "endpoint.json"), "utf8"),
  ) as { pid: number; instanceId?: string };
  assert.ok(endpoint.instanceId, "endpoint.json must carry an instance id");

  const started = await waitForLastEntry(
    daemon.stateDir,
    "Supervisor daemon started",
    (line) => line.data?.instanceId === endpoint.instanceId,
  );
  assert.equal(started.data?.trigger, "direct");
  assert.equal(started.data?.pid, endpoint.pid);
  for (const message of [
    "Supervisor daemon entry",
    "Supervisor daemon lock acquired",
    "Supervisor daemon IPC ready",
  ]) {
    const line = await waitForLastEntry(
      daemon.stateDir,
      message,
      (candidate) => candidate.data?.instanceId === endpoint.instanceId,
    );
    assert.equal(line.data?.instanceId, endpoint.instanceId);
  }

  await daemon.stop();
  const stopped = await waitForLastEntry(
    daemon.stateDir,
    "Supervisor daemon stopped",
    (line) => line.data?.reason === "ipc_request",
  );
  assert.equal(stopped.data?.instanceId, endpoint.instanceId);
  assert.equal(stopped.data?.reason, "ipc_request");
  const exitRecord = JSON.parse(
    await readFile(path.join(daemon.stateDir, "daemon-exit.json"), "utf8"),
  ) as { instanceId: string; status: string; reason: string; stoppedAt?: string };
  assert.equal(exitRecord.instanceId, endpoint.instanceId);
  assert.equal(exitRecord.status, "stopped");
  assert.equal(exitRecord.reason, "ipc_request");
  assert.ok(exitRecord.stoppedAt);

  await daemon.start();
  const raw = await readLog(daemon.stateDir);
  const parsed = lines(raw);
  const stoppedIndex = parsed.findIndex(
    (line) => line.message === "Supervisor daemon stopped" && line.data?.instanceId === endpoint.instanceId,
  );
  const nextEntryIndex = parsed.findIndex(
    (line, index) =>
      index > stoppedIndex &&
      line.message === "Supervisor daemon entry" &&
      line.data?.instanceId !== endpoint.instanceId,
  );
  assert.ok(stoppedIndex >= 0 && nextEntryIndex > stoppedIndex, "stop log must be flushed before the next entry log");
  const previous = entry(raw, "Supervisor daemon previous instance");
  assert.equal(previous?.data?.previousInstanceId, endpoint.instanceId);
  assert.equal(previous?.data?.previousProcess, "exited");
  assert.deepEqual(
    (previous?.data?.previousExit as { reason?: string } | undefined)?.reason,
    "ipc_request",
  );
});

test("a killed daemon records an unknown prior exit and tags recovery events with the new instance", async (t) => {
  const daemon = await TestDaemon.create("hs-lifecycle-crash-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace("hs-lifecycle-crash-work-");
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "5000" } });
  const worker = await spawnWorker(client, cwd, "[scenario:slow] keep running");
  await waitForStatus(client, worker.id, ["running", "awaiting_input"]);
  const oldPid = daemon.child?.pid;
  assert.ok(oldPid);

  await daemon.kill();
  assert.equal(isPidAlive(oldPid), false);
  const nextClient = await daemon.start();
  const endpoint = JSON.parse(
    await readFile(path.join(daemon.stateDir, "endpoint.json"), "utf8"),
  ) as { instanceId?: string };
  assert.ok(endpoint.instanceId);

  const raw = await readLog(daemon.stateDir);
  const previous = entry(raw, "Supervisor daemon previous instance");
  assert.equal(previous?.data?.previousPid, oldPid);
  assert.equal(previous?.data?.previousProcess, "exited");
  assert.equal(previous?.data?.previousExit, "unknown");
  await waitForLastEntry(
    daemon.stateDir,
    "Supervisor daemon started",
    (line) => line.data?.instanceId === endpoint.instanceId,
  );

  const events = await eventsOf(nextClient, worker.id);
  const recovery = events.events.find(
    (event) => event.type === "worker.orphaned" || event.type === "worker.interrupted",
  );
  assert.ok(recovery, "the restarted daemon must record a recovery event");
  assert.equal(
    (recovery.data as { daemonInstanceId?: string }).daemonInstanceId,
    endpoint.instanceId,
  );

  const status = await statusOf(nextClient, worker.id);
  if (status.worker.pid && isPidAlive(status.worker.pid)) {
    try {
      process.kill(status.worker.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

test("a lock conflict is written to daemon.log with the inspected holder", async (t) => {
  const daemon = await TestDaemon.create("hs-lifecycle-lock-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const client = await daemon.start();
  const holderPid = daemon.child?.pid;
  assert.ok(holderPid);

  const second = spawn(process.execPath, [DAEMON_ENTRY, "--state-dir", daemon.stateDir], {
    env: {
      ...process.env,
      HARNESS_SUPERVISOR_HOME: daemon.stateDir,
      HARNESS_SUPERVISOR_PI_ENTRY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  second.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  second.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const exitCode = await new Promise<number | null>((resolve) => {
    second.once("exit", resolve);
  });
  assert.equal(exitCode, 1);
  assert.match(output, /holds the lock file|refusing to recycle/);

  const conflict = entry(await readLog(daemon.stateDir), "Supervisor daemon lock conflict");
  assert.ok(conflict, "the refused starter must log the conflict into daemon.log");
  assert.equal(conflict.data?.lockPid, holderPid);
  assert.equal(conflict.data?.decision, "refuse");
  assert.ok(conflict.data?.instanceId);

  const workers = await client.request<unknown[]>("list", {});
  assert.ok(Array.isArray(workers), "the holder daemon must stay healthy");
});
