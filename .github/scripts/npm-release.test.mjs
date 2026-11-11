import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { alreadyPublished, releaseMetadata, stageRelease, verifyRelease } from "./npm-release.mjs";

const env = { GITHUB_REPOSITORY: "example/hs", GITHUB_EVENT_NAME: "push", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" };
const writeJson = (file, value) => writeFile(file, JSON.stringify(value));
const digest = value => `sha512-${createHash("sha512").update(value).digest("base64")}`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hs-publish-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, ".artifacts"));
  await mkdir(path.join(root, "packages/dsh-plugin/src"), { recursive: true });
  await mkdir(path.join(root, "packages/dsh-plugin/.artifacts"));
  await writeJson(path.join(root, "package.json"), { name: "harness-supervisor", version: "1.2.3" });
  await writeJson(path.join(root, "package-lock.json"), { version: "1.2.3", packages: { "": { version: "1.2.3" } } });
  await writeFile(path.join(root, "src/version.ts"), 'export const VERSION = "1.2.3";');
  await writeFile(path.join(root, "packages/dsh-plugin/src/index.js"), 'const EXPECTED_CORE_VERSION = "1.2.3"; const status = { pluginVersion: "4.5.6" };');
  await writeJson(path.join(root, "packages/dsh-plugin/package.json"), { name: "dsh-harness-supervisor", version: "4.5.6", dependencies: { "harness-supervisor": "1.2.3" }, bundleDependencies: ["harness-supervisor"], repository: { url: "git+https://github.com/example/hs.git", directory: "packages/dsh-plugin" } });
  return root;
}

test("only the exact stable core tag can authorize publishing; manual runs only validate metadata", async () => {
  const root = await fixture();
  assert.equal((await releaseMetadata(root, env)).pluginVersion, "4.5.6");
  for (const tag of ["v1.2.4", "v1.2.3-beta.1", "v01.2.3", "v1.2.3\ninvalid"]) await assert.rejects(() => releaseMetadata(root, { ...env, GITHUB_REF_NAME: tag }), /Release tag/);
  await assert.rejects(() => releaseMetadata(root, { ...env, GITHUB_REF_TYPE: "branch" }), /Release tag/);
  assert.equal((await releaseMetadata(root, { ...env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" })).coreVersion, "1.2.3");
  await assert.rejects(() => releaseMetadata(root, { ...env, GITHUB_EVENT_NAME: "pull_request" }), /Unsupported/);
});

test("version drift, dependency ranges and mismatched provenance repositories fail before packaging", async () => {
  const mutations = [
    ["package-lock.json", value => ({ ...value, version: "9.9.9" }), /lock versions/],
    ["packages/dsh-plugin/package.json", value => ({ ...value, version: "4.5.6-beta.1" }), /stable semver/],
    ["packages/dsh-plugin/package.json", value => ({ ...value, dependencies: { "harness-supervisor": "^1.2.3" } }), /pin the exact/],
    ["packages/dsh-plugin/package.json", value => ({ ...value, repository: { ...value.repository, url: "git+https://gitcode.com/example/hs.git" } }), /trusted publisher/],
  ];
  for (const [file, mutate, pattern] of mutations) {
    const root = await fixture();
    const target = path.join(root, file);
    await writeJson(target, mutate(JSON.parse(await readFile(target, "utf8"))));
    await assert.rejects(() => releaseMetadata(root, env), pattern);
  }
  const root = await fixture();
  await writeFile(path.join(root, "src/version.ts"), 'export const VERSION = "1.2.4";');
  await assert.rejects(() => releaseMetadata(root, env), /source version/);
});

test("the publish artifact is fixed, checksummed and bound to its core and plugin versions", async () => {
  const root = await fixture(), metadata = await releaseMetadata(root, env);
  await writeFile(path.join(root, ".artifacts", metadata.coreTarball), "core-bytes");
  await writeFile(path.join(root, "packages/dsh-plugin/.artifacts", metadata.pluginTarball), "plugin-bytes");
  await writeJson(path.join(root, ".artifacts/core-release.json"), { version: metadata.coreVersion, integrity: digest("core-bytes") });
  await writeJson(path.join(root, "packages/dsh-plugin/.artifacts/release.json"), { coreVersion: metadata.coreVersion, pluginVersion: metadata.pluginVersion, tarball: metadata.pluginTarball, integrity: digest("plugin-bytes") });
  const destination = path.join(root, "release");
  await stageRelease(root, destination, metadata);
  assert.equal((await verifyRelease(destination, metadata)).pluginIntegrity, digest("plugin-bytes"));
  await assert.rejects(() => verifyRelease(destination, { ...metadata, pluginVersion: "9.9.9" }), /pluginVersion/);
  await writeFile(path.join(destination, metadata.pluginTarball), "tampered");
  await assert.rejects(() => verifyRelease(destination, metadata), /Plugin artifact integrity/);
});

test("registry retries skip only identical immutable versions and fail closed on lookup errors", async () => {
  const release = { pluginName: "dsh-harness-supervisor", pluginVersion: "4.5.6", pluginIntegrity: digest("plugin-bytes") };
  assert.equal(await alreadyPublished(release, async () => new Response(null, { status: 404 })), false);
  const published = { name: release.pluginName, version: release.pluginVersion, dist: { integrity: release.pluginIntegrity } };
  assert.equal(await alreadyPublished(release, async () => Response.json(published)), true);
  await assert.rejects(() => alreadyPublished(release, async () => Response.json({ ...published, dist: { integrity: digest("different") } })), /different bytes/);
  await assert.rejects(() => alreadyPublished(release, async () => new Response(null, { status: 503 })), /HTTP 503/);
});
