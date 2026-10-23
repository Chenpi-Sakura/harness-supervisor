// Start a real native Pi UI roundtrip; the receiving Codex thread answers later.
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupervisorClient } from "../dist/src/ipc/client.js";

const { values } = parseArgs({ options: {
  "state-dir": { type: "string" }, cwd: { type: "string" }, thread: { type: "string" },
} });
const threadId = values.thread ?? process.env.CODEX_THREAD_ID;
if (!threadId || !values["state-dir"] || !values.cwd) {
  throw new Error("Use --state-dir <isolated-dir> --cwd <test-workdir> and a verified --thread or CODEX_THREAD_ID");
}
const cwd = path.resolve(values.cwd);
await mkdir(cwd, { recursive: true });
const client = new SupervisorClient({ stateDir: values["state-dir"], autoStart: false });
try {
  await client.connect();
  const worker = await client.request("spawn", {
    cwd,
    prompt: "This is a technical integration test. After the native extension input has been answered, use the write tool to create input-proof.txt with exactly HS_INPUT_CONTINUED_OK. Only operate in the current working directory. Reply INPUT_DONE.",
    name: "native-input-roundtrip",
    notifyTarget: { channel: "codex-queue", codexThreadId: threadId },
    maxDurationMs: 240000,
    extraArgs: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--extension",
      fileURLToPath(new URL("../test/fixtures/real-pi-input-extension.mjs", import.meta.url))],
  }, { timeoutMs: 90000 });
  const proof = { threadId, workerId: worker.id, status: worker.status, at: new Date().toISOString() };
  await writeFile(path.join(cwd, "spawned.json"), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
} finally {
  client.close();
}
