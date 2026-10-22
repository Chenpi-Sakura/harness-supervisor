import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SupervisorClient } from "../dist/src/ipc/client.js";
import { sleep } from "../dist/src/util/async.js";

const root = path.resolve(".");
const CODEX = "C:/Users/Lenovo/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js";
const hsState = await mkdtemp(path.join(os.tmpdir(), "hs-wake-state-"));
const workDir = await mkdtemp(path.join(os.tmpdir(), "hs-wake-work-"));
const timings = {};
const fakePi = path.join(root, "dist", "test", "fixtures", "fake-harness.js");
const log = (...a) => console.log(new Date().toISOString(), ...a);

// 1. HS daemon with the fake harness (a simulated worker is allowed by the plan).
const hsEnv = { ...process.env, HARNESS_SUPERVISOR_HOME: hsState, HARNESS_SUPERVISOR_PI_ENTRY: fakePi, FAKE_PI_SLOW_STEP_MS: process.env.WAKE_WORKER_STEP_MS || "30000" };
const hsChild = spawn(process.execPath, [path.join(root, "dist", "src", "daemon-entry.js"), "--state-dir", hsState], {
  env: hsEnv,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
hsChild.stdout.on("data", (d) => log("hs", String(d).trim()));
hsChild.stderr.on("data", (d) => log("hs", String(d).trim()));
let hs;
for (let i = 0; i < 100; i += 1) {
  const c = new SupervisorClient({ stateDir: hsState, autoStart: false });
  try {
    await c.connect();
    hs = c;
    break;
  } catch {
    c.close();
    await sleep(100);
  }
}
log("hs ready", hsState);

// 2. Codex app-server session with the HS MCP server attached.
const codex = spawn(process.execPath, [CODEX, "app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buf = "";
const pending = new Map();
const notifications = [];
const turns = [];
codex.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      notifications.push(msg);
      if (msg.method === "turn/started" || msg.method === "turn/completed") {
        log("notif", msg.method, JSON.stringify(msg.params).slice(0, 160));
      }
    }
  }
});
codex.stderr.on("data", (d) => log("codex-stderr", String(d).trim().slice(0, 300)));
let nextId = 1;
function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  codex.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
}

await request("initialize", { clientInfo: { name: "hs-wake-e2e", version: "0.1.0" } });
const thread = await request("thread/start", {
  cwd: workDir,
  approvalPolicy: "never",
  sandbox: "workspace-write",
  config: {
    mcp_servers: {
      harness_supervisor: {
        command: process.execPath,
        args: [path.join(root, "dist", "src", "mcp.js"), "--state-dir", hsState],
        env: { HARNESS_SUPERVISOR_HOME: hsState },
        default_tools_approval_mode: "approve",
      },
    },
  },
});
const threadId = thread.thread.id;
log("thread", threadId);

// 3. Tell the supervisor where to deliver events for this thread.
await hs.request("notification_target", { channel: "codex-queue", codexThreadId: threadId });

// 4. First turn: Codex creates a worker and ends its turn without waiting.
const prompt = [
  "Call the harness_supervisor MCP tool worker_spawn exactly once with:",
  `cwd=${workDir}`,
  'prompt="[scenario:slow] simulated long worker task"',
  'runtime="pi"',
  "Then END YOUR TURN immediately. Do not call worker_wait and do not guess the outcome.",
  "Reply with the worker id in one short line.",
  "You will be woken later with a notification; only then read the worker result.",
].join("\n");
await request("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
for (let i = 0; i < 240; i += 1) {
  const done = notifications.filter((n) => n.method === "turn/completed");
  if (done.length >= 1) break;
  await sleep(500);
}
const firstTurn = notifications.find((n) => n.method === "turn/completed");
const firstText = JSON.stringify(firstTurn?.params ?? {}).slice(0, 1200);
timings.firstTurnCompletedAt = new Date().toISOString();
log("first turn completed", firstText.slice(0, 300));

// 5. Wait for the worker to finish, then for the host to start a second turn by itself.
let autoWoke = false;
let deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  await sleep(1000);
  const started = notifications.filter((n) => n.method === "turn/started");
  if (started.length >= 2) {
    autoWoke = true;
    break;
  }
}
timings.autoWokeObservedAt = new Date().toISOString();
log("autoWoke", autoWoke);

let secondText = "";
if (autoWoke) {
  deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const completed = notifications.filter((n) => n.method === "turn/completed");
    if (completed.length >= 2) break;
    await sleep(500);
  }
  const secondTurn = notifications.filter((n) => n.method === "turn/completed")[1];
  secondText = JSON.stringify(secondTurn?.params ?? {});
  log("second turn completed", secondText.slice(0, 600));
}

const inbox = await hs.request("notifications", { state: "all", limit: 20 });
const workers = await hs.request("list", {});
const result = {
  threadId,
  hsState,
  workDir,
  workerIds: workers.map((w) => `${w.id}:${w.status}`),
  autoWoke,
  notificationCounts: inbox.counts,
  notifications: inbox.notifications.map((n) => ({
    id: n.id,
    kind: n.kind,
    delivery: n.delivery,
  })),
  firstTurn: firstText,
  secondTurn: secondText.slice(0, 2000),
  timings,
  turnsStarted: notifications.filter((n) => n.method === "turn/started").length,
  turnCompletions: notifications.filter((n) => n.method === "turn/completed").length,
};
await mkdir(path.join(root, "evidence", "codex-wake-e2e"), { recursive: true });
await writeFile(
  path.join(root, "evidence", "codex-wake-e2e", process.env.WAKE_RESULT_NAME || "result.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
log("RESULT", JSON.stringify({ autoWoke, counts: inbox.counts, turnsStarted: result.turnsStarted }));

await hs.request("shutdown", {}, { timeoutMs: 30_000 }).catch(() => undefined);
hs.close();
codex.kill();
hsChild.kill();
process.exit(autoWoke ? 0 : 1);