import { test } from "node:test";
import assert from "node:assert/strict";

process.env.HS_TEST_SECRET_TOKEN = "super-secret-env-value-123";
process.env.HS_TEST_SECRET_KEY = "envkeyvalue0987654321";

const { redactText, safeText, truncateText } = await import("../../src/util/redact.js");

test("redacts common API key and bearer formats", () => {
  const text = [
    "key sk-abcdef1234567890",
    "Authorization: Bearer abcdefghijklmnop",
    "api_key=verysecretvalue",
    "token: another-secret",
  ].join("\n");
  const redacted = redactText(text);
  assert.ok(!redacted.includes("sk-abcdef1234567890"));
  assert.ok(!redacted.includes("abcdefghijklmnop"));
  assert.ok(!redacted.includes("verysecretvalue"));
  assert.ok(!redacted.includes("another-secret"));
  assert.match(redacted, /\[REDACTED\]/);
});

test("redacts sensitive environment values", () => {
  const redacted = redactText(
    "env says super-secret-env-value-123 and envkeyvalue0987654321",
  );
  assert.ok(!redacted.includes("super-secret-env-value-123"));
  assert.ok(!redacted.includes("envkeyvalue0987654321"));
});

test("redacts private key blocks", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBgkq\n-----END PRIVATE KEY-----";
  assert.equal(redactText(key), "[REDACTED PRIVATE KEY]");
});

test("safeText truncates and redacts", () => {
  const value = safeText(`sk-abcdef1234567890 ${"x".repeat(100)}`, 20);
  assert.ok(value.length <= 60);
  assert.ok(!value.includes("sk-abcdef1234567890"));
  assert.match(value, /truncated/);
});

test("truncateText reports whether it truncated", () => {
  assert.deepEqual(truncateText("short", 10), { text: "short", truncated: false });
  const cut = truncateText("abcdefghij", 4);
  assert.equal(cut.truncated, true);
  assert.match(cut.text, /^abcd/);
});
