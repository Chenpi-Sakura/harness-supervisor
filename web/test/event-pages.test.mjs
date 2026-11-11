import assert from "node:assert/strict";
import test from "node:test";
import { EventPager, EVENT_PAGE_SIZE, eventHistoryStatus } from "../src/event-pages.ts";
import { buildTimelineEntries } from "../src/event-presentation.ts";

const event = seq => ({ seq, ts: "2026-11-11T00:00:00Z", type: "run.progress", data: { kind: "thinking", preview: `word${seq} ` } });
const log = count => Array.from({ length: count }, (_, index) => event(index + 1));

function fixture(initial, batchSize = 100) {
  let records = initial;
  let history;
  const calls = [];
  const pager = new EventPager(async (sinceSeq, limit) => {
    calls.push({ sinceSeq, limit });
    const remaining = records.filter(row => row.seq > sinceSeq);
    const events = remaining.slice(0, Math.min(limit, batchSize));
    return { events, nextSeq: events.at(-1)?.seq ?? sinceSeq, hasMore: remaining.length > events.length };
  }, value => { history = value; });
  return { pager, calls, get history() { return history; }, setRecords(value) { records = value; }, setBatchSize(value) { batchSize = value; } };
}

test("more than 300 historical events remain accessible, with bounded pages and reversible cursors", async () => {
  const state = fixture(log(1250));
  const seen = [];
  await state.pager.read();
  assert.equal(state.history.events.length, EVENT_PAGE_SIZE);
  assert.equal(state.history.events[0].seq, 1);
  seen.push(...state.history.events.map(row => row.seq));
  await state.pager.read("next");
  assert.equal(state.history.events[0].seq, 501);
  seen.push(...state.history.events.map(row => row.seq));
  await state.pager.read("next");
  assert.equal(state.history.events[0].seq, 1001);
  assert.equal(state.history.hasMore, false);
  seen.push(...state.history.events.map(row => row.seq));
  assert.deepEqual(seen, Array.from({ length: 1250 }, (_, index) => index + 1));
  await state.pager.read("previous");
  assert.deepEqual(state.history.events.map(row => row.seq), seen.slice(500, 1000));
  await state.pager.read("previous");
  assert.deepEqual(state.history.events.map(row => row.seq), seen.slice(0, 500));
  assert.equal(state.history.hasPrevious, false);
  assert.ok(state.calls.every(call => call.limit <= 100));
});

test("adjacent thinking fragments join across API batches while raw counts and cursor stay unchanged", async () => {
  const records = log(420);
  records[99].data.preview = " end of batch";
  records[100].data.preview = "\n  next batch ";
  const state = fixture(records);
  await state.pager.read();
  const entries = buildTimelineEntries(state.history.events, "dsh");
  assert.equal(state.history.events.length, 420);
  assert.equal(state.history.nextSeq, 420);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].events.length, 420);
  assert.ok(entries[0].recordedText.includes(" end of batch\n  next batch "));
});

test("refresh appends without duplicates and a full page only probes without evicting earlier events", async () => {
  const state = fixture(log(37));
  await state.pager.read();
  state.setRecords(log(500));
  await state.pager.read();
  await state.pager.read();
  assert.deepEqual(state.history.events.map(row => row.seq), log(500).map(row => row.seq));
  assert.equal(state.history.hasMore, false);
  state.setRecords(log(640));
  await state.pager.read();
  assert.equal(state.history.hasMore, true);
  assert.equal(state.history.nextSeq, 500);
  assert.equal(state.history.events[0].seq, 1);
  assert.deepEqual(state.calls.at(-1), { sinceSeq: 500, limit: 1 });
  await state.pager.read("next");
  assert.deepEqual(state.history.events.map(row => row.seq), log(640).slice(500).map(row => row.seq));
  state.setRecords(log(700));
  await state.pager.read("previous");
  await state.pager.read();
  assert.equal(state.history.nextSeq, 500);
  assert.equal(state.history.events.at(-1).seq, 500);
});

test("known history boundaries remain frozen even if a backend returns short batches", async () => {
  const state = fixture(log(200), 10);
  await state.pager.read();
  assert.equal(state.calls.length, 5, "one refresh has a fixed request budget");
  assert.equal(state.history.nextSeq, 50);
  await state.pager.read("next");
  assert.equal(state.history.events[0].seq, 51);
  await state.pager.read("previous");
  await state.pager.read();
  assert.equal(state.history.events.length, 50);
  assert.equal(state.history.nextSeq, 50);
});

test("a partially reloaded old page catches up before next without overwriting known later-page cursors", async () => {
  const state = fixture(log(1500));
  await state.pager.read();
  await state.pager.read("next");
  await state.pager.read("next");
  assert.equal(state.history.page, 2);
  assert.equal(state.history.events[0].seq, 1001);
  state.setBatchSize(10);
  await state.pager.read("previous");
  assert.equal(state.history.page, 1);
  assert.equal(state.history.nextSeq, 550);
  assert.equal(state.history.hasMoreInPage, true);
  await state.pager.read("next");
  assert.equal(state.history.page, 1, "next first continues reading the existing frozen page");
  assert.equal(state.history.nextSeq, 600);
  while (state.history.hasMoreInPage) await state.pager.read("next");
  assert.equal(state.history.nextSeq, 1000);
  assert.deepEqual(state.history.events.map(row => row.seq), log(1500).slice(500, 1000).map(row => row.seq));
  await state.pager.read("next");
  assert.equal(state.history.page, 2);
  assert.equal(state.history.events[0].seq, 1001, "the saved third-page boundary was not replaced by a partial cursor");
  assert.equal(state.history.nextSeq, 1050);
});

test("a previously seen partial tail also keeps its boundary when revisited through short batches", async () => {
  const state = fixture(log(1250));
  await state.pager.read();
  await state.pager.read("next");
  await state.pager.read("next");
  assert.equal(state.history.nextSeq, 1250);
  await state.pager.read("previous");
  state.setBatchSize(10);
  await state.pager.read("next");
  assert.equal(state.history.page, 2);
  assert.equal(state.history.events[0].seq, 1001);
  assert.equal(state.history.hasMoreInPage, true);
  while (state.history.hasMoreInPage) await state.pager.read("next");
  assert.equal(state.history.nextSeq, 1250);
  assert.equal(state.history.hasMore, false);
  state.setRecords(log(1270));
  await state.pager.read();
  assert.equal(state.history.nextSeq, 1250, "new records cannot move an already frozen tail");
  assert.equal(state.history.hasMore, true);
  await state.pager.read("next");
  assert.equal(state.history.events[0].seq, 1251);
});

test("overlapping refresh/navigation requests are serialized and disposed selections cannot publish", async () => {
  let release;
  let calls = 0;
  const published = [];
  const pager = new EventPager(() => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  }, value => published.push(value));
  const pending = pager.read();
  await pager.read();
  await pager.read("next");
  assert.equal(calls, 1);
  assert.equal(published.at(-1).loading, true);
  pager.dispose();
  const fresh = fixture([event(9)]);
  await fresh.pager.read();
  release({ events: [event(1)], nextSeq: 1, hasMore: false });
  await pending;
  assert.equal(published.length, 1, "old selection did not publish after disposal");
  assert.equal(fresh.history.events[0].seq, 9);
});

test("failed batches retain the prior page and retry from its committed cursor", async () => {
  let fail = true;
  let history;
  const calls = [];
  const pager = new EventPager(async (sinceSeq, limit) => {
    calls.push(sinceSeq);
    if (sinceSeq === 100 && fail) throw new Error("offline");
    const events = log(320).filter(row => row.seq > sinceSeq).slice(0, limit);
    return { events, nextSeq: events.at(-1)?.seq ?? sinceSeq, hasMore: events.at(-1)?.seq < 320 };
  }, value => { history = value; });
  await assert.rejects(pager.read(), /offline/);
  assert.equal(history.events.length, 0);
  assert.equal(history.nextSeq, 0);
  assert.equal(history.loading, false);
  fail = false;
  await pager.read();
  assert.equal(calls[2], 0);
  assert.equal(history.events.length, 320);
  assert.equal(new Set(history.events.map(row => row.seq)).size, 320);
});

test("a nonadvancing pagination cursor fails explicitly rather than spinning or skipping history", async () => {
  let history;
  const pager = new EventPager(async () => ({ events: [], nextSeq: 0, hasMore: true }), value => { history = value; });
  await assert.rejects(pager.read(), /游标未前进/);
  assert.equal(history.loading, false);
  assert.equal(history.nextSeq, 0);
});

test("persistent event failures never report an empty completed history and only event success clears the error", async () => {
  let fail = true;
  let history;
  const updates = [];
  const pager = new EventPager(async () => {
    if (fail) throw new Error("event service unavailable");
    return { events: [], nextSeq: 0, hasMore: false };
  }, value => { history = value; updates.push(value); });
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(pager.read(), /event service unavailable/);
    assert.equal(history.loaded, false);
    assert.equal(history.error, "event service unavailable");
    assert.ok(!eventHistoryStatus(history).includes("末尾"));
    assert.ok(!eventHistoryStatus(history).includes("暂无"));
  }
  fail = false;
  await pager.read();
  assert.equal(history.loaded, true);
  assert.equal(history.error, null);
  assert.ok(eventHistoryStatus(history).includes("末尾"), "only a successful event response can establish the end of the log");
  fail = true;
  await assert.rejects(pager.read(), /event service unavailable/);
  assert.equal(history.loaded, true);
  assert.ok(!eventHistoryStatus(history).includes("末尾"));
  assert.ok(eventHistoryStatus(history).includes("失败"));
  assert.equal(updates.at(-2).error, null, "a previous successful history remains separate from its later failure");
});
