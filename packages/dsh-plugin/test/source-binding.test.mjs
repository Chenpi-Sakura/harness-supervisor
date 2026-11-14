import assert from "node:assert/strict";
import test from "node:test";
import { createSourceBinding } from "../src/source-binding.js";
const tick = () => new Promise(resolve => setImmediate(resolve));

test("source updates cancel pending mounts, coalesce intermediate choices and dispose the last connection", async () => {
  const mounts = [], closed = [];
  const binding = createSourceBinding(config => {
    mounts.push(config);
    let finish;
    const fiber = new Promise(resolve => { finish = resolve; });
    fiber.dispose = async () => { if (!closed.includes(config)) closed.push(config); finish(); };
    return fiber;
  });
  const first = binding.update("bundled");
  await tick();
  const middle = binding.update("npm");
  const last = binding.update("custom");
  await first;
  await middle;
  await tick();
  assert.deepEqual(mounts, ["bundled", "custom"]);
  assert.deepEqual(closed, ["bundled"]);
  await binding.dispose();
  await last;
  assert.deepEqual(closed, ["bundled", "custom"]);
  await binding.update("must-not-mount");
  assert.equal(mounts.length, 2);
});

test("a failed source is cleaned and a later source can still connect", async () => {
  let cleanups = 0;
  const binding = createSourceBinding(config => {
    const fiber = config === "broken" ? Promise.reject(new Error("invalid source")) : Promise.resolve();
    fiber.dispose = async () => { cleanups++; };
    return fiber;
  });
  await assert.rejects(binding.update("broken"), /invalid source/);
  await binding.update("npm");
  await binding.dispose();
  assert.equal(cleanups, 2);
});

test("a failed connection cleanup blocks replacement and is retained for a confirmed retry", async () => {
  const mounts = [];
  let refuse = true;
  const binding = createSourceBinding(config => {
    mounts.push(config);
    const fiber = Promise.resolve();
    fiber.dispose = async () => { if (refuse) throw new Error("still connected"); };
    return fiber;
  });
  await binding.update("bundled");
  await assert.rejects(binding.update("npm"), /still connected/);
  await assert.rejects(binding.update("custom"), /still connected/);
  assert.deepEqual(mounts, ["bundled"]);
  refuse = false;
  await binding.update("npm");
  assert.deepEqual(mounts, ["bundled", "npm"]);
  await binding.dispose();
});
