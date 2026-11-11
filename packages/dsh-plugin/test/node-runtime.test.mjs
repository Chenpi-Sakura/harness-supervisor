import assert from "node:assert/strict";
import test from "node:test";
import { resolveNodeExecutable } from "../src/node-runtime.js";

test("native hosts reuse Node and Electron hosts never accidentally launch the GUI", () => {
  assert.equal(resolveNodeExecutable("", { versions: {}, execPath: process.execPath }), process.execPath);
  assert.equal(resolveNodeExecutable(process.execPath), process.execPath);
  assert.throws(() => resolveNodeExecutable("node"), /absolute/);
  assert.throws(() => resolveNodeExecutable("", { versions: { electron: "42" }, execPath: "/missing/electron", platform: "linux" }), /will not launch Electron/);
});
