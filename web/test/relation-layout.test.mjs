import assert from "node:assert/strict";
import test from "node:test";
import { layoutRelationWorkers, selectRelationProject } from "../src/relation-layout.ts";

const worker = (id, ownerRef, cwd = "D:/Project", status = "running") => ({ id, ownerRef, cwd, status });
const master = (ownerRef, cwd) => ({ ownerRef, cwd, harness: "dsh" });

test("relation projects use the navigation's Windows identity for workers and Masters", () => {
  const workers = [worker("one", "a"), worker("two", "b", "d:\\project"), worker("outside", "a", "D:/Other")];
  const masters = [master("empty", "d:\\PROJECT"), master("outside-master", "D:/Other")];
  const project = selectRelationProject(workers, masters, "d:/PROJECT");
  assert.equal(project.project, "d:/PROJECT", "retain the selected display path");
  assert.deepEqual(project.projectWorkers.map(value => value.id), ["one", "two"]);
  assert.deepEqual(project.owners, ["a", "b", "empty"]);
  const layout = layoutRelationWorkers(project.projectWorkers, project.owners, "project", "a", "all");
  assert.deepEqual(layout.groups.map(group => group.owner), ["a", "b", "empty"]);
  assert.deepEqual(layout.groups[2].members, [], "a live Master remains visible before its first Worker");
});

test("preferred sessions without Workers resolve their Master's project and preserve path boundaries", () => {
  const workers = [worker("other", "other"), worker("upper", "upper", "/Repo"), worker("lower", "lower", "/repo")];
  const masters = [master("current", "C:/Empty")];
  const empty = selectRelationProject(workers, masters, undefined, "current");
  assert.equal(empty.project, "C:/Empty");
  assert.deepEqual(empty.projectWorkers, []);
  assert.deepEqual(empty.owners, ["current"]);
  assert.deepEqual(selectRelationProject(workers, masters, "/Repo").projectWorkers.map(value => value.id), ["upper"]);
  const unc = selectRelationProject([worker("unc", "a", "\\\\Server\\Share\\Repo")], [master("b", "\\\\server\\share\\repo")]);
  assert.deepEqual(unc.owners, ["a", "b"]);
});

test("layout keeps input order, owner boundaries and existing node geometry", () => {
  const workers = [worker("a-one", "a"), worker("b-one", "b"), worker("a-two", "a"), worker("external", undefined)];
  const layout = layoutRelationWorkers(workers, ["a", "b", "empty"], "project", "a", "all");
  assert.deepEqual(layout.visible, workers);
  assert.deepEqual(layout.groups.map(group => group.owner), ["a", "b", "", "empty"]);
  assert.deepEqual(layout.groups.map(group => [group.x, group.width, group.height]), [[0, 668, 686], [716, 348, 686], [1112, 348, 686], [1508, 348, 686]]);
  assert.deepEqual(layout.positions, [
    { x: 32, y: 370, masterX: 192, masterY: 70 },
    { x: 748, y: 370, masterX: 748, masterY: 70 },
    { x: 352, y: 370, masterX: 192, masterY: 70 },
    { x: 1144, y: 370, masterX: 1144, masterY: 70 },
  ]);
  assert.equal(layout.width, 1856);
  assert.equal(layout.height, 686);
  const external = layoutRelationWorkers(workers, [], "session", "", "all");
  assert.deepEqual(external.visible.map(value => value.id), ["external"]);
  assert.deepEqual(external.positions, [{ x: 0, y: 300, masterX: 0, masterY: 0 }]);
});

test("filtering changes visible geometry without rewriting group state or working counts", () => {
  const workers = [worker("active", "a"), worker("done", "a", "D:/Project", "completed"), worker("waiting", "b", "D:/Project", "awaiting_input")];
  const layout = layoutRelationWorkers(workers, ["a", "b"], "project", "a", "terminal");
  assert.deepEqual(layout.visible.map(value => value.id), ["done"]);
  assert.deepEqual(layout.groups.map(group => [group.members.length, group.state]), [[1, "completed"], [0, "awaiting_input"]]);
  assert.equal(layout.working, 1);
  const empty = layoutRelationWorkers([], ["empty"], "session", "empty", "active");
  assert.equal(empty.width, 284);
  assert.equal(empty.height, 584);
  assert.deepEqual(empty.positions, []);
});

test("node lookup work stays linear across many interleaved sessions", () => {
  let idReads = 0, ownerReads = 0;
  const count = 600;
  const workers = Array.from({ length: count }, (_, index) => ({
    get id() { idReads++; return String(index); },
    get ownerRef() { ownerReads++; return `session-${index % 30}`; },
    cwd: "D:/Project", status: "running",
  }));
  const layout = layoutRelationWorkers(workers, [], "project", "session-0", "all");
  assert.equal(layout.positions.length, count);
  assert.equal(layout.groups.length, 30);
  assert.ok(idReads <= count * 3, `node lookup read ${idReads} ids for ${count} Workers`);
  assert.ok(ownerReads <= count * 3, `grouping read ${ownerReads} owners for ${count} Workers`);
  assert.equal(new Set(layout.positions.map(point => `${point.x}:${point.y}`)).size, count);
});
