import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { harnessNames, harnessName, modelDisplay } from "../src/harness-catalog.ts";

test("every supported Harness has a local licensed icon and theme color", () => {
  const icons = readFileSync(new URL("../src/harness-icons.css", import.meta.url), "utf8");
  const colors = readFileSync(new URL("../src/worker-relations.css", import.meta.url), "utf8");
  for (const runtime of Object.keys(harnessNames)) {
    const match = icons.match(new RegExp(`harness-icon--${runtime} \\{[^}]*url\\("([^"\\n]+)"\\)`));
    assert.ok(match, runtime);
    const svg = readFileSync(new URL(`../src/${match[1]}`, import.meta.url), "utf8");
    assert.match(svg, /<svg/);
    assert.doesNotMatch(svg, /<script|<foreignObject/);
    assert.match(colors, new RegExp(`brand-${runtime} \\{ --brand-color:`));
  }
  assert.equal(harnessName("claude"), "Claude Code");
  assert.equal(harnessName("future-runtime"), "future-runtime");
});

test("reported models take precedence; requested settings and missing reports stay explicit", () => {
  assert.equal(modelDisplay({ model: "requested", runtimeInfo: { modelId: "actual", modelName: "Native model" } }), "Native model");
  assert.equal(modelDisplay({ runtimeInfo: { modelId: "actual" } }), "actual");
  assert.equal(modelDisplay({ config: { model: "requested" } }), "requested（请求）");
  assert.equal(modelDisplay({}), "型号未上报");
});
