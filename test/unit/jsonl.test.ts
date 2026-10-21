import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonlDecoder, serializeJsonLine } from "../../src/util/jsonl.js";

function collect(): {
  records: Array<Record<string, unknown>>;
  invalid: Array<{ raw: string; error: Error }>;
  decoder: JsonlDecoder;
} {
  const records: Array<Record<string, unknown>> = [];
  const invalid: Array<{ raw: string; error: Error }> = [];
  const decoder = new JsonlDecoder(
    (record) => records.push(record),
    (raw, error) => invalid.push({ raw, error }),
  );
  return { records, invalid, decoder };
}

test("decodes multiple records across arbitrary byte boundaries", () => {
  const payload = `${serializeJsonLine({ n: 1, text: "héllo 😀" })}${serializeJsonLine({ n: 2, text: "世界" })}`;
  const bytes = Buffer.from(payload, "utf8");
  const { records, decoder } = collect();
  for (let i = 0; i < bytes.length; i += 1) {
    decoder.push(bytes.subarray(i, i + 1));
  }
  decoder.end();
  assert.deepEqual(records, [
    { n: 1, text: "héllo 😀" },
    { n: 2, text: "世界" },
  ]);
});

test("does not split on U+2028 / U+2029 and strips CRLF", () => {
  const line = JSON.stringify({ text: "a\u2028b\u2029c" });
  const { records, decoder } = collect();
  decoder.push(`${line}\r\n{"ok":true}\n`);
  decoder.end();
  assert.deepEqual(records, [{ text: "a\u2028b\u2029c" }, { ok: true }]);
});

test("reports invalid JSON but continues with later records", () => {
  const { records, invalid, decoder } = collect();
  decoder.push("not json\n{\"ok\":1}\n");
  decoder.end();
  assert.equal(invalid.length, 1);
  assert.deepEqual(records, [{ ok: 1 }]);
});

test("parses a final line without a newline on end", () => {
  const { records, decoder } = collect();
  decoder.push('{"last":true}');
  assert.equal(records.length, 0);
  decoder.end();
  assert.deepEqual(records, [{ last: true }]);
});

test("ignores empty lines and non-object records", () => {
  const { records, invalid, decoder } = collect();
  decoder.push("\n\n[1,2]\n{\"ok\":1}\n");
  decoder.end();
  assert.equal(invalid.length, 1);
  assert.deepEqual(records, [{ ok: 1 }]);
});
