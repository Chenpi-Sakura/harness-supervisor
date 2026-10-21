import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IPC_VERSION,
  ipcEndpoint,
  parseEnvelope,
  parseHello,
  tokenDigest,
} from "../../src/ipc/protocol.js";

test("IPC endpoint is deterministic and platform-appropriate", () => {
  const a = ipcEndpoint("C:\\temp\\state-a");
  const b = ipcEndpoint("C:\\temp\\state-a");
  const c = ipcEndpoint("C:\\temp\\state-b");
  assert.equal(a, b);
  assert.notEqual(a, c);
  if (process.platform === "win32") {
    assert.match(a, /^\\\\\.\\pipe\\harness-supervisor-/);
  } else {
    assert.match(a, /supervisor\.sock$/);
  }
});

test("token digests are comparable fixed-length buffers", () => {
  const a = tokenDigest("abc");
  const b = tokenDigest("abc");
  const c = tokenDigest("abd");
  assert.equal(a.length, 32);
  assert.ok(a.equals(b));
  assert.ok(!a.equals(c));
});

test("parses a valid hello and rejects malformed ones", () => {
  assert.ok(
    parseHello({
      v: IPC_VERSION,
      type: "hello",
      token: "x".repeat(64),
    }),
  );
  assert.equal(parseHello({ v: 99, type: "hello", token: "x" }), null);
  assert.equal(parseHello({ v: IPC_VERSION, type: "nope" }), null);
});

test("validates request envelopes and method params", () => {
  const valid = parseEnvelope({
    v: IPC_VERSION,
    type: "request",
    id: "1",
    method: "status",
    params: { workerId: "w-1" },
  });
  assert.ok("envelope" in valid);
  assert.equal(valid.envelope.method, "status");

  const missingWorker = parseEnvelope({
    v: IPC_VERSION,
    type: "request",
    id: "2",
    method: "status",
    params: {},
  });
  assert.ok("error" in missingWorker);
  assert.equal(missingWorker.error.code, "BAD_REQUEST");

  const unknownMethod = parseEnvelope({
    v: IPC_VERSION,
    type: "request",
    id: "3",
    method: "rm-rf",
    params: {},
  });
  assert.ok("error" in unknownMethod);

  const extraField = parseEnvelope({
    v: IPC_VERSION,
    type: "request",
    id: "4",
    method: "status",
    params: { workerId: "w-1", sneaky: true },
  });
  assert.ok("error" in extraField);
});
