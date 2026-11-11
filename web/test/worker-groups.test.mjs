import assert from "node:assert/strict";
import test from "node:test";
import { directoryGroupExpanded, directoryGroupKey, groupWorkersByDirectory, groupWorkersByFolder, groupWorkersByOwner, ownerGroupExpanded, ownerGroupKey } from "../src/worker-groups.ts";

const worker = (id, ownerRef, cwd = "D:/Project") => ({ id, ownerRef, cwd });

test("current owner is first while shared folders and external workers remain distinct", () => {
  const workers = [worker("other", "dsh:b"), worker("legacy", undefined), worker("current", "dsh:a"), worker("unowned-string", "unowned")];
  const groups = groupWorkersByOwner(workers, "dsh:a");
  assert.deepEqual(groups.map(group => group.workers.map(value => value.id)), [["current"], ["other"], ["legacy"], ["unowned-string"]]);
  assert.equal(groups[0].label, "当前会话");
  assert.equal(groups[0].current, true);
  assert.equal(groups[2].label, "未归属 / 外部任务");
  assert.notEqual(groups[2].key, groups[3].key, "an owner named unowned is not an unowned record");
  assert.ok(groups[1].label.includes("dsh:b"));
  assert.equal(groups.flatMap(group => group.workers).length, workers.length);
});

test("only current owner is expanded by default and newly paged outside owners remain folded", () => {
  const workers = [worker("current", "a"), worker("other", "b")];
  const overrides = new Map();
  const initial = groupWorkersByOwner(workers, "a");
  assert.deepEqual(initial.map(group => ownerGroupExpanded(group.key, "a", overrides)), [true, false]);
  const next = groupWorkersByOwner([...workers, worker("current-new", "a"), worker("new-owner", "c")], "a");
  assert.deepEqual(next[0].workers.map(value => value.id), ["current", "current-new"]);
  assert.deepEqual(next.map(group => ownerGroupExpanded(group.key, "a", overrides)), [true, false, false]);
});

test("manual expansion and collapse survive refresh and reordering without mutating defaults", () => {
  const overrides = new Map([[ownerGroupKey("b"), true], [ownerGroupKey("a"), false]]);
  const refreshed = groupWorkersByOwner([worker("new-b", "b"), worker("new-a", "a"), worker("new-c", "c")], "a");
  assert.deepEqual(refreshed.map(group => ownerGroupExpanded(group.key, "a", overrides)), [false, true, false]);
  assert.deepEqual([...overrides], [[ownerGroupKey("b"), true], [ownerGroupKey("a"), false]]);
});

test("global CLI view exposes all groups and an empty preferred session stays visible", () => {
  const workers = [worker("a", "a"), worker("external", undefined)];
  const global = groupWorkersByOwner(workers);
  assert.ok(global.every(group => ownerGroupExpanded(group.key, undefined, new Map())));
  assert.ok(global.every(group => !group.current));
  const emptyCurrent = groupWorkersByOwner(workers, "current-without-workers");
  assert.equal(emptyCurrent[0].current, true);
  assert.deepEqual(emptyCurrent[0].workers, []);
  assert.equal(ownerGroupExpanded(emptyCurrent[0].key, "current-without-workers", new Map()), true);
});

test("directory grouping keeps Windows case rules without merging POSIX case or separate owners", () => {
  const workers = [worker("one", "a", "D:/Project/Work"), worker("two", "a", "d:\\project\\work"), worker("upper", "a", "/Project"), worker("lower", "a", "/project")];
  assert.deepEqual(groupWorkersByDirectory(workers).map(group => group.workers.map(value => value.id)), [["one", "two"], ["upper"], ["lower"]]);
  assert.equal(directoryGroupKey("\\\\Server\\Share\\Work"), directoryGroupKey("\\\\server\\share\\work"));
  const owners = groupWorkersByOwner([worker("one", "a"), worker("two", "b")]);
  assert.ok(owners.every(group => groupWorkersByDirectory(group.workers).length === 1));
  assert.notEqual(owners[0].key, owners[1].key);
});

test("a shared folder is one root containing its actual sessions and workers", () => {
  const workers = [worker("a", "session-a"), worker("b", "session-b"), worker("external", undefined)];
  const folders = groupWorkersByFolder(workers, "session-a");
  assert.equal(folders.length, 1);
  assert.equal(folders[0].current, true);
  assert.deepEqual(folders[0].workers.map(value => value.id), ["a", "b", "external"]);
  assert.deepEqual(folders[0].owners.map(owner => owner.workers.map(value => value.id)), [["a"], ["b"], ["external"]]);
  assert.equal(folders[0].owners[0].label, "当前会话");
  assert.equal(folders[0].owners[2].label, "未归属 / 外部任务");
});

test("one current session working in several folders appears separately under each folder", () => {
  const workers = [worker("outside", "other", "D:/Outside"), worker("a", "current", "D:/First"), worker("b", "current", "D:/Second"), worker("inside-other", "other", "D:/First")];
  const folders = groupWorkersByFolder(workers, "current");
  assert.deepEqual(folders.map(folder => folder.cwd), ["D:/First", "D:/Second", "D:/Outside"]);
  assert.deepEqual(folders.slice(0, 2).map(folder => folder.owners[0].workers.map(value => value.id)), [["a"], ["b"]]);
  assert.deepEqual(folders.map(folder => folder.current), [true, true, false]);
  assert.equal(folders.flatMap(folder => folder.owners.flatMap(owner => owner.workers)).length, workers.length);
});

test("current folder ancestors open by default while unrelated folders and sessions stay folded", () => {
  const folders = groupWorkersByFolder([worker("inside-other", "other"), worker("current", "current"), worker("outside", "outside", "D:/Elsewhere")], "current");
  assert.deepEqual(folders.map(folder => directoryGroupExpanded(folder, "current", new Map())), [true, false]);
  assert.deepEqual(folders[0].owners.map(owner => ownerGroupExpanded(owner.key, "current", new Map())), [true, false]);
  assert.ok(folders.every(folder => directoryGroupExpanded(folder, undefined, new Map())));
});

test("a current session without workers creates no phantom folder or empty owner", () => {
  const folders = groupWorkersByFolder([worker("other", "other", "D:/Folder")], "missing-current");
  assert.equal(folders.length, 1);
  assert.equal(folders[0].current, false);
  assert.equal(folders[0].owners.length, 1);
  assert.equal(folders[0].owners[0].ownerRef, "other");
  assert.ok(folders.every(folder => folder.owners.every(owner => owner.workers.length > 0 && !owner.current)));
  assert.deepEqual(groupWorkersByFolder([], "missing-current"), []);
});

test("manual folder decisions survive new pages, reordered input and default-current changes", () => {
  const current = worker("current", "current", "D:/Current");
  const other = worker("other", "other", "D:/Other");
  const initial = groupWorkersByFolder([other, current], "current");
  const overrides = new Map([[initial[0].key, false], [initial[1].key, true]]);
  const refreshed = groupWorkersByFolder([current, worker("new", "new", "D:/New"), other, worker("another-current", "current", "d:/current")], "current");
  assert.deepEqual(refreshed.map(folder => directoryGroupExpanded(folder, "current", overrides)), [false, false, true]);
  assert.equal(refreshed[0].workers.length, 2);
  assert.equal(overrides.size, 2);
});

test("folder roots normalize Windows case but do not merge equal basenames from different paths", () => {
  const folders = groupWorkersByFolder([
    worker("a", "a", "D:/First/Project"), worker("b", "b", "d:\\first\\project"),
    worker("c", "a", "D:/Second/Project"), worker("d", "b", "\\\\Server\\Share\\Work"), worker("e", "c", "\\\\server\\share\\work"),
  ]);
  assert.equal(folders.length, 3);
  assert.deepEqual(folders.map(folder => folder.workers.map(value => value.id)), [["a", "b"], ["c"], ["d", "e"]]);
  assert.notEqual(folders[0].key, folders[1].key);
  assert.equal(folders[0].cwd, "D:/First/Project", "the original display path is retained");
});
