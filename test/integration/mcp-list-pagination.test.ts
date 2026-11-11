import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../../src/store.js";
import { SCHEMA_VERSION, type WorkerRecord } from "../../src/types.js";
import { MCP_ENTRY, TestDaemon, makeWorkspace } from "./helpers.js";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

function parseTool(result: ToolResult): any {
  assert.notEqual(result.isError, true, result.content[0]?.text);
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text, "tool result has no text");
  return JSON.parse(text);
}

function rawText(result: ToolResult): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

async function connectMcp(t: TestContext, stateDir: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY, "--state-dir", stateDir],
    env: { ...process.env, HARNESS_SUPERVISOR_MCP_MODE: "" },
    stderr: "pipe",
  });
  const mcp = new Client({ name: "hs-list-pagination", version: "1.0.0" });
  await mcp.connect(transport);
  t.after(async () => {
    await mcp.close().catch(() => undefined);
  });
  return mcp;
}

async function call(
  mcp: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await mcp.callTool({ name, arguments: args })) as ToolResult;
}

function makeRecord(id: string, createdAt: string): WorkerRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    runtime: "pi",
    cwd: process.cwd(),
    promptPreview: "pagination fixture",
    status: "completed",
    createdAt,
    updatedAt: createdAt,
    lastSeq: 0,
    eventCount: 0,
    stats: { turns: 0, toolCalls: 0, toolErrors: 0 },
    capabilities: {
      runtime: "pi",
      steer: true,
      followUp: true,
      cancel: true,
      resume: true,
      pause: false,
      interactiveInput: true,
      notes: "pagination fixture",
    },
    config: {},
    resumeCount: 0,
    supervisorId: "pagination-fixture",
  } as WorkerRecord;
}

/** Three workers share each createdAt to exercise the id tie-breaker. */
function seedRecord(index: number, prefix: string): WorkerRecord {
  const base = Date.parse("2025-01-01T00:00:00.000Z");
  const id = `${prefix}${String(index).padStart(4, "0")}`;
  return makeRecord(id, new Date(base + Math.floor(index / 3) * 1000).toISOString());
}

function expectedOrder(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => seedRecord(index, prefix))
    .sort((a, b) => {
      const byCreatedAt = b.createdAt.localeCompare(a.createdAt);
      return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id);
    })
    .map((record) => record.id);
}

async function seedWorkers(stateDir: string, count: number, prefix: string): Promise<void> {
  const store = new Store(stateDir);
  await store.init();
  const records = Array.from({ length: count }, (_, index) => seedRecord(index, prefix));
  for (let start = 0; start < records.length; start += 100) {
    await Promise.all(records.slice(start, start + 100).map((record) => store.createWorker(record)));
  }
}

async function traverse(
  mcp: Client,
  firstPage: Record<string, unknown> = {},
): Promise<{ ids: string[]; pages: number; last: any }> {
  let cursor: string | undefined;
  const ids: string[] = [];
  let pages = 0;
  let last: any;
  for (;;) {
    const page = parseTool(
      await call(mcp, "worker_list", {
        ...firstPage,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }),
    );
    pages += 1;
    ids.push(...page.workers.map((worker: { id: string }) => worker.id));
    last = page;
    if (!page.hasMore) {
      assert.equal(page.nextCursor, null, "the final page must not advertise a cursor");
      break;
    }
    assert.equal(typeof page.nextCursor, "string");
    cursor = page.nextCursor;
    assert.ok(pages < 100, "pagination failed to terminate");
  }
  return { ids, pages, last };
}

test("worker_list paginates the complete 1,200-worker history without duplicates", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-list-page-"));
  await seedWorkers(stateDir, 1_200, "w-page-");
  const daemon = new TestDaemon(stateDir);
  t.after(() => daemon.stop());
  await daemon.start();
  const mcp = await connectMcp(t, stateDir);

  const expected = expectedOrder(1_200, "w-page-");
  const { ids, pages, last } = await traverse(mcp);

  assert.equal(ids.length, 1_200, `expected every worker, got ${ids.length} over ${pages} pages`);
  assert.equal(new Set(ids).size, 1_200, "no worker id may repeat across pages");
  assert.deepEqual(ids, expected, "keyset order must be stable: createdAt DESC, id ASC");
  assert.equal(pages, 12);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextCursor, null);
  assert.ok(
    last.workers.every(
      (worker: Record<string, unknown>) =>
        !("cwd" in worker) && !("session" in worker) && !("result" in worker),
    ),
    "pagination must not widen the production field whitelist",
  );
});

test("a keyset cursor stays correct when workers are added, archived or deleted", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-list-page-live-"));
  await seedWorkers(stateDir, 300, "w-conc-");
  const daemon = new TestDaemon(stateDir);
  t.after(() => daemon.stop());
  await daemon.start({ env: { FAKE_PI_STEP_MS: "1" } });
  const mcp = await connectMcp(t, stateDir);
  const expected = expectedOrder(300, "w-conc-");

  const first = parseTool(await call(mcp, "worker_list", { limit: 100 }));
  const firstIds = first.workers.map((worker: { id: string }) => worker.id);
  assert.deepEqual(firstIds, expected.slice(0, 100));
  assert.equal(first.hasMore, true);

  const cursorWorker = expected[99]!;
  const nextExpected = expected[100]!;
  const forgotten = expected[150]!;
  const archived = expected[200]!;

  // Delete the cursor record itself: the next page must still start after it.
  parseTool(await call(mcp, "worker_forget", { workerId: cursorWorker }));
  parseTool(await call(mcp, "worker_forget", { workerId: forgotten }));
  parseTool(await call(mcp, "worker_admin", { workerId: archived, action: "archive" }));

  // New workers are newer than the seeded set, so they sort before the cursor.
  const cwd = await makeWorkspace();
  const created: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const spawned = parseTool(
      await call(mcp, "worker_spawn", {
        cwd,
        prompt: `[scenario:normal] concurrent addition ${index}`,
        notifyTarget: { channel: "none" },
      }),
    );
    created.push(spawned.id);
  }

  const rest: string[] = [];
  let cursor: string | undefined = first.nextCursor;
  while (cursor) {
    const page = parseTool(
      await call(mcp, "worker_list", { limit: 100, cursor }),
    );
    rest.push(...page.workers.map((worker: { id: string }) => worker.id));
    cursor = page.hasMore ? page.nextCursor : undefined;
    if (!page.hasMore) {
      assert.equal(page.nextCursor, null);
    }
  }

  assert.equal(rest[0], nextExpected, "deleting the cursor record must not skip its successor");
  const combined = [...firstIds, ...rest];
  assert.equal(new Set(combined).size, combined.length, "no duplicate across mutated pages");
  assert.equal(combined.includes(forgotten), false, "a forgotten worker must disappear");
  assert.equal(combined.includes(archived), false, "an archived worker stays hidden by default");
  assert.equal(combined.includes(cursorWorker), true, "the cursor worker was already returned");
  for (const id of created) {
    assert.equal(
      combined.includes(id),
      false,
      "workers created after the cursor must not appear in later pages",
    );
  }
  const remainingExpected = expected
    .slice(100)
    .filter((id) => id !== forgotten && id !== archived);
  assert.deepEqual(
    rest,
    remainingExpected,
    "remaining pages must cover every surviving unarchived worker exactly once",
  );

  // includeArchived keeps the archived record reachable, while forget is final.
  const withArchived = await traverse(mcp, { includeArchived: true });
  assert.equal(withArchived.ids.includes(archived), true);
  assert.equal(withArchived.ids.includes(forgotten), false);
  for (const id of created) assert.equal(withArchived.ids.includes(id), true);
});

test("worker_list rejects a malformed cursor instead of guessing a position", async (t) => {
  const daemon = await TestDaemon.create("hs-list-page-bad-");
  t.after(() => daemon.stop());
  await daemon.start();
  const mcp = await connectMcp(t, daemon.stateDir);

  const rejected = await call(mcp, "worker_list", { cursor: "not-a-valid-cursor" });
  assert.equal(rejected.isError, true);
  assert.match(rawText(rejected), /^BAD_REQUEST: .*Invalid worker_list cursor/);

  const nonCanonical = Buffer.from(
    JSON.stringify({ v: 1, createdAt: "2026-11-10", id: "w-1" }),
    "utf8",
  ).toString("base64url");
  const shapeRejected = await call(mcp, "worker_list", { cursor: nonCanonical });
  assert.equal(shapeRejected.isError, true);
  assert.match(
    rawText(shapeRejected),
    /^BAD_REQUEST: .*Invalid worker_list cursor/,
    "a parseable but non-canonical timestamp must not become a keyset position",
  );
});
