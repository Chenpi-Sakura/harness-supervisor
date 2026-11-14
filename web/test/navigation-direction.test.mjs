import assert from "node:assert/strict";
import test from "node:test";
import { navigationDirection } from "../src/navigation-direction.ts";

const groups = [
  { cwd: "A", owners: [{ ownerRef: "a1" }, { ownerRef: "a2" }] },
  { cwd: "B", owners: [{ ownerRef: "b1" }, { ownerRef: "b2" }] },
  { cwd: "C", owners: [{ ownerRef: "c1" }] },
];
test("folder direction remains correct when the preferred owner belongs to another project", () => {
  assert.equal(navigationDirection(groups, "B", "a1", "A", "a1"), 1);
  assert.equal(navigationDirection(groups, "B", "a1", "C", "c1"), -1);
  assert.equal(navigationDirection(groups, "C", "a1", "B", "b1"), 1);
});
test("session direction follows sibling order inside the current folder", () => {
  assert.equal(navigationDirection(groups, "B", "b1", "B", "b2"), -1);
  assert.equal(navigationDirection(groups, "B", "b2", "B", "b1"), 1);
});
test("legacy owners use the same ordering for empty and absent references", () => {
  const groups = [{ cwd: "project", owners: [{ ownerRef: "session" }, {}] }];
  assert.equal(navigationDirection(groups, "project", "", "project", "session"), 1);
  assert.equal(navigationDirection(groups, "project", "session", "project", ""), -1);
});
