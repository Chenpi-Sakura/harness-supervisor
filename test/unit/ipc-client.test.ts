import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SupervisorClient } from "../../src/ipc/client.js";
import { ensureIpcToken } from "../../src/ipc/daemon-state.js";
import { ipcEndpoint } from "../../src/ipc/protocol.js";

for (const scoped of [true, false]) {
  test(`a ${scoped ? "strict legacy hello" : "bad IPC token"} never auto-starts a replacement daemon`, async (t) => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-legacy-hello-"));
    await ensureIpcToken(stateDir);
    const marker = path.join(stateDir, "replacement-started");
    const entry = path.join(stateDir, "sentinel.cjs");
    await writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`);
    let connections = 0;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      connections++;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("data", () => socket.write(JSON.stringify({ v: 1, type: "hello_response", ok: false, error: { code: "UNAUTHORIZED", message: scoped ? "Invalid hello" : "Unauthorized" } }) + "\n"));
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(ipcEndpoint(stateDir), resolve); });
    const client = new SupervisorClient({ stateDir, daemonEntry: entry, ...(scoped ? { scope: { ownerRef: "dsh:legacy", notifyNone: true } } : {}) });
    t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    await assert.rejects(() => client.connect(), scoped ? { code: "UNSUPPORTED", message: /maintenance window/ } : { code: "UNAUTHORIZED" });
    assert.equal(connections, 1);
    assert.equal(existsSync(marker), false);
  });
}
