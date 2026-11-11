import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { alreadyPublished, publishedPackages, releaseMetadata, stageRelease, verifyRelease, waitForPublished } from "./npm-release.mjs";

const env = { GITHUB_REPOSITORY: "example/hs", GITHUB_EVENT_NAME: "push", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" };
const writeJson = (file, value) => writeFile(file, JSON.stringify(value));
const digest = value => `sha512-${createHash("sha512").update(value).digest("base64")}`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hs-publish-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, ".artifacts"));
  await mkdir(path.join(root, "packages/dsh-plugin/src"), { recursive: true });
  await mkdir(path.join(root, "packages/dsh-plugin/.artifacts"));
  await writeJson(path.join(root, "package.json"), { name: "harness-supervisor", version: "1.2.3", repository: { url: "git+https://github.com/example/hs.git" } });
  await writeJson(path.join(root, "package-lock.json"), { version: "1.2.3", packages: { "": { version: "1.2.3" } } });
  await writeFile(path.join(root, "src/version.ts"), 'export const VERSION = "1.2.3";');
  await writeFile(path.join(root, "packages/dsh-plugin/src/index.js"), 'const EXPECTED_CORE_VERSION = "1.2.3"; const status = { pluginVersion: "4.5.6" };');
  await writeJson(path.join(root, "packages/dsh-plugin/package.json"), { name: "dsh-harness-supervisor", version: "4.5.6", dependencies: { "harness-supervisor": "1.2.3" }, bundleDependencies: ["harness-supervisor"], repository: { url: "git+https://github.com/example/hs.git", directory: "packages/dsh-plugin" } });
  return root;
}

test("only the exact stable core tag can authorize publishing; manual runs only validate metadata", async () => {
  const root = await fixture();
  const release = await releaseMetadata(root, env);
  assert.equal(release.coreName, "harness-supervisor");
  assert.equal(release.coreTarball, "harness-supervisor-1.2.3.tgz");
  assert.equal(release.pluginVersion, "4.5.6");
  for (const tag of ["v1.2.4", "v1.2.3-beta.1", "v01.2.3", "v1.2.3\ninvalid"]) await assert.rejects(() => releaseMetadata(root, { ...env, GITHUB_REF_NAME: tag }), /Release tag/);
  await assert.rejects(() => releaseMetadata(root, { ...env, GITHUB_REF_TYPE: "branch" }), /Release tag/);
  assert.equal((await releaseMetadata(root, { ...env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" })).coreVersion, "1.2.3");
  await assert.rejects(() => releaseMetadata(root, { ...env, GITHUB_EVENT_NAME: "pull_request" }), /Unsupported/);
});

test("version drift, dependency ranges and mismatched provenance repositories fail before packaging", async () => {
  const mutations = [
    ["package-lock.json", value => ({ ...value, version: "9.9.9" }), /lock versions/],
    ["package.json", value => ({ ...value, private: true }), /Core must be public/],
    ["package.json", value => ({ ...value, repository: { url: "git+https://gitcode.com/example/hs.git" } }), /Core repository.url/],
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
  assert.equal((await verifyRelease(destination, metadata)).coreIntegrity, digest("core-bytes"));
  await assert.rejects(() => verifyRelease(destination, { ...metadata, coreVersion: "9.9.9" }), /coreVersion/);
  await assert.rejects(() => verifyRelease(destination, { ...metadata, pluginVersion: "9.9.9" }), /pluginVersion/);
  await writeFile(path.join(destination, metadata.coreTarball), "tampered");
  await assert.rejects(() => verifyRelease(destination, metadata), /Core artifact integrity/);
  await writeFile(path.join(destination, metadata.coreTarball), "core-bytes");
  await writeFile(path.join(destination, metadata.pluginTarball), "tampered");
  await assert.rejects(() => verifyRelease(destination, metadata), /Plugin artifact integrity/);
});

test("registry retries skip only identical immutable versions and fail closed on lookup errors", async () => {
  for (const pkg of [
    { name: "harness-supervisor", version: "1.2.3", integrity: digest("core-bytes") },
    { name: "dsh-harness-supervisor", version: "4.5.6", integrity: digest("plugin-bytes") },
  ]) {
    assert.equal(await alreadyPublished(pkg, async () => new Response(null, { status: 404 })), false);
    const published = { name: pkg.name, version: pkg.version, dist: { integrity: pkg.integrity } };
    assert.equal(await alreadyPublished(pkg, async () => Response.json(published)), true);
    await assert.rejects(() => alreadyPublished(pkg, async () => Response.json({ ...published, dist: { integrity: digest("different") } })), /different bytes/);
    await assert.rejects(() => alreadyPublished(pkg, async () => new Response(null, { status: 503 })), /HTTP 503/);
  }
});

test("a partial core publish can be retried without republishing it or hiding a plugin mismatch", async () => {
  const release = {
    coreName: "harness-supervisor", coreVersion: "1.2.3", coreIntegrity: digest("core-bytes"),
    pluginName: "dsh-harness-supervisor", pluginVersion: "4.5.6", pluginIntegrity: digest("plugin-bytes"),
  };
  const core = { name: release.coreName, version: release.coreVersion, dist: { integrity: release.coreIntegrity } };
  const plugin = { name: release.pluginName, version: release.pluginVersion, dist: { integrity: release.pluginIntegrity } };
  const requested = [];
  assert.deepEqual(await publishedPackages(release, async url => {
    requested.push(url);
    return url.endsWith("/harness-supervisor/1.2.3") ? Response.json(core) : new Response(null, { status: 404 });
  }), { core_published: "true", plugin_published: "false" });
  assert.deepEqual(requested.sort(), ["https://registry.npmjs.org/dsh-harness-supervisor/4.5.6", "https://registry.npmjs.org/harness-supervisor/1.2.3"]);
  assert.deepEqual(await publishedPackages(release, async url => Response.json(url.endsWith("/harness-supervisor/1.2.3") ? core : plugin)), { core_published: "true", plugin_published: "true" });
  await assert.rejects(() => publishedPackages(release, async url => Response.json(url.endsWith("/harness-supervisor/1.2.3") ? core : { ...plugin, dist: { integrity: digest("different") } })), /dsh-harness-supervisor@4.5.6 already exists with different bytes/);
});

test("accepted publications wait for both exact registry versions without publishing again", async () => {
  const release = {
    coreName: "harness-supervisor", coreVersion: "1.2.3", coreIntegrity: digest("core-bytes"),
    pluginName: "dsh-harness-supervisor", pluginVersion: "4.5.6", pluginIntegrity: digest("plugin-bytes"),
  };
  let elapsed = 0, requests = 0;
  const pending = [];
  const result = await waitForPublished(release, {
    now: () => elapsed, sleep: async ms => { elapsed += ms; }, intervalMs: 30, timeoutMs: 120,
    onPending: status => pending.push(status),
    fetcher: async (url, options) => {
      requests++;
      assert.equal(options.method, undefined, "availability verification only reads metadata");
      const core = url.endsWith("/harness-supervisor/1.2.3");
      if (elapsed < (core ? 30 : 60)) return new Response(null, { status: 404 });
      return Response.json({ name: core ? release.coreName : release.pluginName, version: core ? release.coreVersion : release.pluginVersion, dist: { integrity: core ? release.coreIntegrity : release.pluginIntegrity } });
    },
  });
  assert.deepEqual(result, { core_published: "true", plugin_published: "true" });
  assert.deepEqual(pending, [{ core_published: "false", plugin_published: "false" }, { core_published: "true", plugin_published: "false" }]);
  assert.equal(elapsed, 60);
  assert.equal(requests, 6);
});

test("publication availability has a bounded deadline and registry conflicts fail immediately", async () => {
  const release = {
    coreName: "harness-supervisor", coreVersion: "1.2.3", coreIntegrity: digest("core-bytes"),
    pluginName: "dsh-harness-supervisor", pluginVersion: "4.5.6", pluginIntegrity: digest("plugin-bytes"),
  };
  let elapsed = 0, requests = 0;
  await assert.rejects(() => waitForPublished(release, {
    now: () => elapsed, sleep: async ms => { elapsed += ms; }, intervalMs: 30, timeoutMs: 60,
    fetcher: async () => { requests++; return new Response(null, { status: 404 }); },
  }), /accepted but not confirmed public/);
  assert.equal(elapsed, 60);
  assert.equal(requests, 4, "no request is started after the deadline");
  const neverSleep = async () => assert.fail("registry errors must not be retried as pending publication");
  await assert.rejects(() => waitForPublished(release, { sleep: neverSleep, fetcher: async () => new Response(null, { status: 503 }) }), /HTTP 503/);
  await assert.rejects(() => waitForPublished(release, { sleep: neverSleep, fetcher: async () => { throw Error("network unavailable"); } }), /network unavailable/);
  await assert.rejects(() => waitForPublished(release, { sleep: neverSleep, fetcher: async () => Response.json({ name: release.coreName, version: release.coreVersion, dist: { integrity: digest("different") } }) }), /different bytes/);
});
