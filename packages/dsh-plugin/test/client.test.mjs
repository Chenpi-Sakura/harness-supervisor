import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

for (const [carrier, location] of [["Web", { origin: "http://127.0.0.1:3080" }], ["Desktop", { origin: "null", protocol: "dsh-app:", host: "app" }]]) test(`DSH ${carrier} client opens official Browser from the captured session without submitting a model turn`, async () => {
  const registered = [], opened = [], called = [], cleanups = [];
  const ctx = {
    connection: { rpc: { call: async (...args) => { called.push(args); return { ok: true, value: { url: "http://127.0.0.1:9999/#token=secret" } }; } } },
    sidebarRight: { openTab: (...args) => opened.push(args) },
    commandUi: { register: (value) => { registered.push(value); return () => {}; } },
    slots: { inject: (_, fn) => fn(), register: () => () => {} },
    effect: (fn) => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); },
  };
  const exports = {};
  const sandbox = { exports, require: (name) => { assert.equal(name, "react"); return { createElement() {} }; },
    window: { location, alert() {} }, AbortController, URL };
  vm.runInNewContext(await readFile(new URL("../src/client.cjs", import.meta.url), "utf8"), sandbox);
  exports.apply(ctx);
  registered[0].ui.run({ sessionId: "session-a" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called[0][0], "/api");
  assert.equal(called[0][1], "harness-supervisor/open-ui");
  assert.equal(called[0][2].sessionId, "session-a");
  assert.equal(called[0][2].applicationOrigin, carrier === "Desktop" ? "dsh-app://app" : location.origin);
  assert.equal(opened[0][0], "browser");
  assert.equal(opened[0][1].params.url, "http://127.0.0.1:9999/#token=secret");
  assert.equal(called.length, 1);
  cleanups.forEach((cleanup) => cleanup());
});
