import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildVersions } from "../src/BuildVersions.tsx";
import { VERSION } from "../../src/version.ts";

test("WebUI build identity never borrows the running daemon version", () => {
  const html = renderToStaticMarkup(React.createElement(BuildVersions, { coreVersion: "0.11.1" }));
  assert.ok(html.includes(`WebUI v${VERSION}`));
  assert.ok(html.includes("HS v0.11.1"));
  assert.match(renderToStaticMarkup(React.createElement(BuildVersions)), /HS 未连接/);
});
