import assert from "node:assert/strict";
import { test } from "node:test";
import { TestDaemon } from "./helpers.js";
import { SupervisorClient } from "../../src/ipc/client.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("daemon enables authenticated WebUI by default and ui_stop keeps it stopped", async (t) => {
  const daemon = await TestDaemon.create("hs-default-ui-");
  t.after(() => daemon.stop());
  const client = await daemon.start({ env: { HARNESS_SUPERVISOR_UI: "1" } });
  let status: { running: boolean; origin?: string } = { running: false };
  for (let attempt = 0; attempt < 50; attempt++) {
    status = await client.request("ui_status", {});
    if (status.running) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (status.running) {
    assert.deepEqual(status, { running: true, origin: "http://127.0.0.1:61114" });
    assert.equal((await fetch(`${status.origin}/api/session`)).status, 401);
  } else {
    const log = await readFile(path.join(daemon.stateDir, "daemon.log"), "utf8");
    assert.match(log, /EADDRINUSE/);
    assert.match(log, /Default WebUI could not start/);
    t.diagnostic("Port 61114 is occupied; daemon remains usable without replacing its owner");
  }
  await client.request("ui_stop", {});
  assert.deepEqual(await client.request("ui_status", {}), { running: false });
});

test("daemon can opt out of default WebUI and still serve IPC", async (t) => {
  const daemon = await TestDaemon.create("hs-no-default-ui-");
  t.after(() => daemon.stop());
  const client = await daemon.start({ env: { HARNESS_SUPERVISOR_UI: "0" } });
  assert.deepEqual(await client.request("ui_status", {}), { running: false });
});

test("a host client starts its own daemon on port 61115 without changing its parent environment", async (t) => {
  const daemon = await TestDaemon.create("hs-host-ui-");
  const client = new SupervisorClient({ stateDir: daemon.stateDir, uiPort: 61115 });
  t.after(async () => { await client.shutdown(); client.close(); });
  const previous = process.env.HARNESS_SUPERVISOR_UI_PORT;
  await client.connect();
  let status: { running: boolean; origin?: string } = { running: false };
  for (let attempt = 0; attempt < 50; attempt++) {
    status = await client.request("ui_status", {});
    if (status.running) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(status, { running: true, origin: "http://127.0.0.1:61115" });
  assert.equal(process.env.HARNESS_SUPERVISOR_UI_PORT, previous);
});
