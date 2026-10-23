// Each receiving Codex conversation runs this with its own verified identity.
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SupervisorClient } from "../dist/src/ipc/client.js";
const { values } = parseArgs({ options: {
  "state-dir": { type: "string" }, cwd: { type: "string" }, thread: { type: "string" }, label: { type: "string" },
} });
const threadId = values.thread ?? process.env.CODEX_THREAD_ID;
const label = values.label;
if (!threadId || !values["state-dir"] || !values.cwd || !label || !/^[A-Z0-9_]+$/.test(label)) {
  throw new Error("Provide state-dir, cwd, verified thread and an uppercase label");
}
const cwd = path.resolve(values.cwd);
await mkdir(cwd, { recursive: true });
const client = new SupervisorClient({ stateDir: values["state-dir"], autoStart: false });
try {
  await client.connect();
  const worker = await client.request("spawn", {
    cwd, name: `route-${label}`, requestId: `desktop-e2e-${label}`,
    prompt: `Use bash to sleep 45 seconds, then use write to create route-proof.txt containing exactly ${label}_OK, without newline. Operate only in the current directory. Reply ${label}_DONE.`,
    notifyTarget: { channel: "codex-queue", codexThreadId: threadId }, maxDurationMs: 180000,
    extraArgs: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"],
  }, { timeoutMs: 90000 });
  const proof = { threadId, workerId: worker.id, label, status: worker.status, at: new Date().toISOString() };
  await writeFile(path.join(cwd, "spawned.json"), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
} finally { client.close(); }
