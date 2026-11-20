import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JOB_STALE_AFTER_MS, observeJob, readJobEvidence } from "../../src/jobs.js";
import type { JobEvidenceV1, WorkerJobLink } from "../../src/types.js";
import { Deferred } from "../../src/util/async.js";

const link: WorkerJobLink = {
  jobId: "job-1",
  location: "local",
  stage: "train",
  turn: 1,
  evidencePath: "/tmp/job.json",
  attachedAt: "2026-01-01T00:00:00.000Z",
};

function evidence(overrides: Partial<JobEvidenceV1> = {}): JobEvidenceV1 {
  return {
    v: 1,
    jobId: "job-1",
    state: "running",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("job observation reports missing evidence as unknown with the stage to inspect", () => {
  const observation = observeJob(link, { problem: "evidence file not found" }, null);
  assert.equal(observation.state, "unknown");
  assert.equal(observation.inspectStage, "train");
  assert.equal(observation.exitCodeKnown, false);
});

test("job observation separates exited, failed, running and stale states", () => {
  assert.equal(observeJob(link, { evidence: evidence({ state: "running" }) }, null).state, "running");
  assert.equal(
    observeJob(
      link,
      { evidence: evidence({ state: "running", updatedAt: new Date(Date.now() - JOB_STALE_AFTER_MS - 1000).toISOString() }) },
      null,
    ).state,
    "stale",
  );
  const exited = observeJob(link, { evidence: evidence({ state: "exited", exitCode: 0 }) }, null);
  assert.equal(exited.state, "exited");
  assert.equal(exited.exitCodeKnown, true);
  const failed = observeJob(link, { evidence: evidence({ state: "failed", exitCode: 2 }) }, null);
  assert.equal(failed.state, "failed");
  assert.equal(failed.exitCode, 2);
});

test("missing exit code is reported instead of being treated as success", () => {
  const observation = observeJob(link, { evidence: evidence({ state: "exited" }) }, null);
  assert.equal(observation.state, "exited");
  assert.equal(observation.exitCodeKnown, false);
  assert.match(observation.problem ?? "", /exitCode/);
});

test("running evidence with a dead recorded pid is reported unknown, not running", () => {
  const observation = observeJob(link, { evidence: evidence({ state: "running" }) }, false);
  assert.equal(observation.state, "unknown");
  assert.match(observation.problem ?? "", /pid is not alive/);
});

test("expected artifacts are checked against evidence artifacts", () => {
  const withExpected = { ...link, expectedArtifacts: ["model", "metrics"] };
  const observation = observeJob(
    withExpected,
    { evidence: evidence({ artifacts: [{ name: "model", path: "out/model.bin" }] }) },
    null,
  );
  assert.deepEqual(observation.missingArtifacts, ["metrics"]);
});

test("readJobEvidence rejects foreign job ids, missing files and oversized evidence", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-jobs-unit-"));
  try {
    const foreign = path.join(dir, "foreign.json");
    await writeFile(foreign, JSON.stringify(evidence({ jobId: "other-job" })));
    const foreignRead = await readJobEvidence({ ...link, evidencePath: "foreign.json" }, dir);
    assert.match(foreignRead.problem ?? "", /belongs to job "other-job"/);

    const missing = await readJobEvidence({ ...link, evidencePath: "missing.json" }, dir);
    assert.match(missing.problem ?? "", /not found/);

    const oversized = path.join(dir, "large.json");
    await writeFile(oversized, "x".repeat(256 * 1024 + 1));
    const oversizedRead = await readJobEvidence({ ...link, evidencePath: "large.json" }, dir);
    assert.match(oversizedRead.problem ?? "", /over the .*byte cap/);

    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "hs-jobs-outside-"));
    try {
      const outside = path.join(outsideDir, "outside.json");
      await writeFile(outside, JSON.stringify(evidence()));
      const scoped = await readJobEvidence({ ...link, evidencePath: outside }, dir);
      assert.match(scoped.problem ?? "", /outside the allowed roots/);
      await t.test("canonical paths reject redirects outside the allowed root", async (subtest) => {
        try {
          await symlink(outsideDir, path.join(dir, "redirect"), process.platform === "win32" ? "junction" : "dir");
        } catch (error) {
          if (process.platform !== "win32" || !["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          subtest.skip("Creating a junction is restricted in this environment");
          return;
        }
        const redirected = await readJobEvidence({ ...link, evidencePath: path.join("redirect", "outside.json") }, dir);
        assert.match(redirected.problem ?? "", /outside the allowed roots/);
      });
      const allowed = await readJobEvidence({ ...link, evidencePath: outside }, dir, {
        allowedRoots: [dir, outsideDir],
      });
      assert.equal(allowed.evidence?.jobId, "job-1");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the evidence deadline includes path resolution and closes a late file handle", { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-jobs-deadline-"));
  const file = path.join(dir, "evidence.json");
  await writeFile(file, JSON.stringify(evidence()));
  const realpath = fs.realpath;
  const handle = await fs.open(file, "r");
  const releaseOpen = new Deferred<void>();
  const closed = new Deferred<void>();
  const close = handle.close.bind(handle);
  t.after(async () => {
    releaseOpen.resolve();
    await close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  const blockedPath = new Deferred<string>();
  const realpathMock = t.mock.method(fs, "realpath", () => blockedPath.promise);
  const options = { timeoutMs: 50 };
  const evidenceLink = { ...link, evidencePath: file };
  assert.match((await readJobEvidence(evidenceLink, dir, options)).problem ?? "", /exceeded 50ms/);
  realpathMock.mock.restore();
  blockedPath.resolve(await realpath(dir));

  t.mock.method(handle, "close", async () => {
    await close();
    closed.resolve();
  });
  const opening = new Deferred<void>();
  t.mock.method(fs, "open", async () => {
    opening.resolve();
    await releaseOpen.promise;
    return handle;
  });
  const pending = readJobEvidence(evidenceLink, dir, { timeoutMs: 250 });
  await opening.promise;
  assert.match((await pending).problem ?? "", /exceeded 250ms/);
  releaseOpen.resolve();
  await closed.promise;
  assert.equal(handle.fd, -1);
});
