#!/usr/bin/env node
/**
 * Real Pi -> Supervisor CLI -> real Pi worker end-to-end evidence run.
 *
 * A parent native Pi process is asked to use its bash/read tools to:
 *   1. run a script that asks the supervisor to spawn and wait for a child Pi worker,
 *   2. read the file that the child worker created,
 *   3. report success.
 *
 * Cost control: one parent Pi session with a small tool budget, one child Pi worker,
 * flash model, 150s child deadline, 210s parent deadline.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, readFile, copyFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiLaunch } from "../dist/src/adapters/pi/launch.js";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(root, "evidence", "parent-pi");
const cliPath = path.join(root, "dist", "src", "cli.js");
const model = process.env.REAL_PI_MODEL ?? "deepseek-v4.1-flash-1017";
const provider = process.env.REAL_PI_PROVIDER ?? "new-api";
const posix = (value) => value.replaceAll("\\", "/");

function cleanEnv(stateDir) {
  const env = { ...process.env };
  for (const key of [
    "HARNESS_SUPERVISOR_PI_ENTRY",
    "HARNESS_SUPERVISOR_PI_BIN",
    "HARNESS_SUPERVISOR_PI_ARGS",
    "FAKE_PI_SCENARIO",
    "FAKE_PI_STEP_MS",
    "FAKE_PI_SLOW_STEP_MS",
    "HARNESS_SUPERVISOR_HOME",
  ]) {
    delete env[key];
  }
  env.HARNESS_SUPERVISOR_HOME = stateDir;
  return env;
}

function quote(value) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

async function runCli(args, env, timeout = 60_000) {
  return exec(process.execPath, [cliPath, ...args], {
    env,
    timeout,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-parent-pi-state-"));
  const workDir = await mkdtemp(path.join(os.tmpdir(), "hs-parent-pi-work-"));
  const env = cleanEnv(stateDir);
  const result = {
    startedAt: new Date().toISOString(),
    model,
    provider,
    stateDir,
    workDir,
    parentExitCode: null,
    childStatus: null,
    childResult: null,
    assertions: {},
    error: null,
  };
  let parentProc = null;

  const childPrompt = [
    "Perform this one task now:",
    "1. In the current working directory, create a file named worker-output.txt using the write tool.",
    "2. Put exactly SUPERVISOR_E2E_OK (with a trailing newline) in that file.",
    "3. Do not read, create, edit, or run anything outside the current working directory.",
    "4. When done, reply with exactly: WORKER_DONE",
    "Do not ask for confirmation.",
  ].join("\n");
  const childPromptFile = path.join(evidenceDir, "child-prompt.txt");
  await writeFile(childPromptFile, `${childPrompt}\n`, "utf8");

  const childRunScript = path.join(evidenceDir, "run-child-worker.sh");
  const extraArgs = JSON.stringify([
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
  ]);
  const cliCommand = [
    "cat",
    quote(posix(childPromptFile)),
    "|",
    "node",
    quote(posix(cliPath)),
    "spawn",
    "--state-dir",
    quote(posix(stateDir)),
    "--cwd",
    quote(posix(workDir)),
    "--model",
    quote(model),
    "--provider",
    quote(provider),
    "--thinking",
    "off",
    "--tools",
    "read,bash,write",
    "--max-duration-ms",
    "150000",
    "--extra-args",
    `'${extraArgs}'`,
    "--prompt",
    "-",
    "--wait",
    "--json",
  ].join(" ");
  await writeFile(
    childRunScript,
    `#!/usr/bin/env bash\nset -euo pipefail\ncd ${quote(posix(workDir))}\n${cliCommand}\n`,
    "utf8",
  );

  const parentPrompt = [
    "You are the parent agent in a Harness Supervisor end-to-end test.",
    "Do not analyze or modify the repository. Do not start extra workers.",
    "Use your bash tool to run this exact command once:",
    `bash ${quote(posix(childRunScript))}`,
    "",
    "That command asks Harness Supervisor to start a separate native Pi worker,",
    "wait for it to finish, and print one JSON document. It may take up to two minutes.",
    "After it finishes, use your read tool to read this file:",
    posix(path.join(workDir, "worker-output.txt")),
    "",
    "Then reply with exactly: PARENT_E2E_OK",
  ].join("\n");
  await writeFile(path.join(evidenceDir, "parent-prompt.txt"), `${parentPrompt}\n`, "utf8");

  try {
    const up = await runCli(["up", "--state-dir", stateDir], env);
    result.daemonUpOutput = up.stdout.trim();
    console.log("Daemon:", up.stdout.trim());

    const launch = resolvePiLaunch(env);
    const parentArgs = [
      ...launch.args,
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--provider",
      provider,
      "--model",
      model,
      "--thinking",
      "off",
      "--tools",
      "bash,read",
      parentPrompt,
    ];
    console.log("Starting parent Pi...");
    parentProc = spawn(launch.file, parentArgs, {
      cwd: workDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let parentStdout = "";
    let parentStderr = "";
    parentProc.stdout.on("data", (chunk) => {
      parentStdout += chunk.toString("utf8");
      process.stdout.write(chunk);
    });
    parentProc.stderr.on("data", (chunk) => {
      parentStderr += chunk.toString("utf8");
      process.stderr.write(chunk);
    });
    await waitForSpawn(parentProc);
    const parentDeadline = setTimeout(() => {
      console.error("Parent Pi timed out; terminating its process tree.");
      if (process.platform === "win32") {
        spawn("taskkill.exe", ["/PID", String(parentProc.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        try {
          process.kill(-parentProc.pid, "SIGKILL");
        } catch {
          parentProc.kill("SIGKILL");
        }
      }
    }, 210_000);
    parentDeadline.unref?.();
    const exit = await new Promise((resolve) => {
      parentProc.once("exit", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(parentDeadline);
    result.parentExitCode = exit.code;
    result.parentSignal = exit.signal;
    await writeFile(path.join(evidenceDir, "parent.stdout.txt"), parentStdout, "utf8");
    await writeFile(path.join(evidenceDir, "parent.stderr.txt"), parentStderr, "utf8");

    let outputFile = null;
    try {
      outputFile = await readFile(path.join(workDir, "worker-output.txt"), "utf8");
    } catch {
      outputFile = null;
    }
    await writeFile(
      path.join(evidenceDir, "worker-output.txt"),
      outputFile ?? "[missing]\n",
      "utf8",
    );

    const workersDir = path.join(stateDir, "workers");
    let workerDir = null;
    try {
      const dirs = (await readdir(workersDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      if (dirs.length === 1) workerDir = path.join(workersDir, dirs[0]);
    } catch {
      // No workers.
    }
    if (workerDir) {
      for (const name of ["worker.json", "events.jsonl", "stderr.log"]) {
        await copyFile(path.join(workerDir, name), path.join(evidenceDir, name)).catch(() => undefined);
      }
      try {
        const record = JSON.parse(await readFile(path.join(workerDir, "worker.json"), "utf8"));
        result.childStatus = record.status;
        result.childResult = record.result?.text ?? null;
        result.childId = record.id;
        result.childPid = record.pid;
        result.childSessionFile = record.sessionFile;
        if (record.sessionFile) {
          await copyFile(record.sessionFile, path.join(evidenceDir, "session.jsonl")).catch(
            () => undefined,
          );
        }
      } catch {
        // Evidence files still get copied below.
      }
    }
    await copyFile(path.join(stateDir, "daemon.log"), path.join(evidenceDir, "daemon.log")).catch(
      () => undefined,
    );

    result.assertions.parentExitedZero = exit.code === 0;
    result.assertions.parentReportedOk = parentStdout.includes("PARENT_E2E_OK");
    result.assertions.workerFileCorrect = (outputFile ?? "").trim() === "SUPERVISOR_E2E_OK";
    result.assertions.childCompleted = result.childStatus === "completed";
    const passed = Object.values(result.assertions).every(Boolean);
    result.passed = passed;
    result.finishedAt = new Date().toISOString();
    console.log("\nParent exit:", exit.code, "| child:", result.childStatus);
    console.log("Assertions:", result.assertions);
    if (!passed) {
      result.error = "One or more parent/child assertions failed";
      process.exitCode = 1;
    } else {
      console.log("PARENT_PI_E2E_PASS");
    }
  } catch (error) {
    result.error = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
    console.error("Parent Pi e2e failed:", result.error);
  } finally {
    try {
      await runCli(["down", "--state-dir", stateDir], env, 30_000);
    } catch (error) {
      result.daemonDownError = error instanceof Error ? error.message : String(error);
    }
    result.finishedAt ??= new Date().toISOString();
    await writeFile(
      path.join(evidenceDir, "result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(evidenceDir, "run-child-worker.sh"),
      `#!/usr/bin/env bash\nset -euo pipefail\ncd ${quote(posix(workDir))}\n${cliCommand}\n`,
      "utf8",
    );
  }
}

await main();
