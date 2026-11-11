import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY = "https://registry.npmjs.org";
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const integrity = async (file) => `sha512-${createHash("sha512").update(await readFile(file)).digest("base64")}`;

function ensure(value, message) {
  if (!value) throw new Error(message);
}

/** Validate before installing dependencies or accepting any publish input. */
export async function releaseMetadata(root, env) {
  const core = await json(path.join(root, "package.json"));
  const lock = await json(path.join(root, "package-lock.json"));
  const plugin = await json(path.join(root, "packages/dsh-plugin/package.json"));
  ensure(core.name === "harness-supervisor" && plugin.name === "dsh-harness-supervisor", "Unexpected release package name");
  ensure(STABLE_VERSION.test(core.version) && STABLE_VERSION.test(plugin.version), "Release package versions must be stable semver");
  ensure(lock.version === core.version && lock.packages?.[""]?.version === core.version, "Core manifest and lock versions disagree");
  const source = await readFile(path.join(root, "src/version.ts"), "utf8");
  ensure(/export const VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1] === core.version, "Core source version disagrees with its manifest");
  ensure(plugin.dependencies?.[core.name] === core.version, "Plugin must pin the exact core release version");
  ensure(plugin.bundleDependencies?.includes(core.name) && plugin.private !== true, "Plugin must be public and bundle its fixed core");
  const pluginSource = await readFile(path.join(root, "packages/dsh-plugin/src/index.js"), "utf8");
  ensure(/const EXPECTED_CORE_VERSION\s*=\s*"([^"]+)"/.exec(pluginSource)?.[1] === core.version, "Plugin runtime expects a different core version");
  ensure(/pluginVersion:\s*"([^"]+)"/.exec(pluginSource)?.[1] === plugin.version, "Plugin status version disagrees with its manifest");
  ensure(typeof env.GITHUB_REPOSITORY === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY), "A GitHub repository is required");
  ensure(plugin.repository?.url === `git+https://github.com/${env.GITHUB_REPOSITORY}.git`, "Plugin repository.url must match its GitHub trusted publisher");
  ensure(plugin.repository?.directory === "packages/dsh-plugin", "Plugin repository directory is incorrect");
  const tag = `v${core.version}`;
  ensure(["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME), "Unsupported release workflow event");
  if (env.GITHUB_EVENT_NAME === "push") {
    ensure(env.GITHUB_REF_TYPE === "tag" && env.GITHUB_REF_NAME === tag, `Release tag must be exactly ${tag}`);
  }
  return {
    tag, repository: env.GITHUB_REPOSITORY,
    coreVersion: core.version, coreTarball: `${core.name}-${core.version}.tgz`,
    pluginName: plugin.name, pluginVersion: plugin.version, pluginTarball: `${plugin.name}-${plugin.version}.tgz`,
  };
}

export async function stageRelease(root, destination, metadata) {
  const core = await json(path.join(root, ".artifacts/core-release.json"));
  const plugin = await json(path.join(root, "packages/dsh-plugin/.artifacts/release.json"));
  ensure(core.version === metadata.coreVersion && plugin.coreVersion === metadata.coreVersion && plugin.pluginVersion === metadata.pluginVersion && plugin.tarball === metadata.pluginTarball, "Packed release versions disagree");
  const files = [
    [path.join(root, ".artifacts", metadata.coreTarball), metadata.coreTarball, core.integrity],
    [path.join(root, "packages/dsh-plugin/.artifacts", metadata.pluginTarball), metadata.pluginTarball, plugin.integrity],
  ];
  for (const [file, , expected] of files) ensure(await integrity(file) === expected, "Packed artifact integrity does not match its descriptor");
  await mkdir(destination, { recursive: true });
  for (const [file, name] of files) await copyFile(file, path.join(destination, name));
  await writeFile(path.join(destination, "release.json"), `${JSON.stringify({ ...metadata, coreIntegrity: core.integrity, pluginIntegrity: plugin.integrity }, null, 2)}\n`);
  await verifyRelease(destination, metadata);
}

export async function verifyRelease(directory, metadata) {
  const release = await json(path.join(directory, "release.json"));
  for (const [key, value] of Object.entries(metadata)) ensure(release[key] === value, `Downloaded artifact ${key} does not match this release`);
  const names = (await readdir(directory)).sort();
  ensure(JSON.stringify(names) === JSON.stringify([metadata.coreTarball, metadata.pluginTarball, "release.json"].sort()), "Unexpected or missing release artifact");
  ensure(await integrity(path.join(directory, metadata.coreTarball)) === release.coreIntegrity, "Core artifact integrity check failed");
  ensure(await integrity(path.join(directory, metadata.pluginTarball)) === release.pluginIntegrity, "Plugin artifact integrity check failed");
  return release;
}

/** An existing version is immutable; only an identical artifact may be skipped. */
export async function alreadyPublished(release, fetcher = fetch) {
  const response = await fetcher(`${REGISTRY}/${encodeURIComponent(release.pluginName)}/${encodeURIComponent(release.pluginVersion)}`, {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return false;
  ensure(response.ok, `Cannot check npm release: HTTP ${response.status}`);
  const published = await response.json();
  ensure(published.name === release.pluginName && published.version === release.pluginVersion && published.dist?.integrity === release.pluginIntegrity,
    "This npm version already exists with different bytes; bump the plugin version before publishing");
  return true;
}

async function output(values, env) {
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${value}`);
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

async function main(command) {
  const metadata = await releaseMetadata(ROOT, process.env);
  const destination = path.join(ROOT, "release/npm");
  if (command === "metadata") {
    await output({ core_version: metadata.coreVersion, plugin_version: metadata.pluginVersion, plugin_tarball: metadata.pluginTarball }, process.env);
  } else if (command === "stage") {
    await stageRelease(ROOT, destination, metadata);
  } else if (command === "published") {
    ensure(process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF_TYPE === "tag", "Publishing requires a pushed release tag");
    const release = await verifyRelease(destination, metadata);
    await output({ published: String(await alreadyPublished(release)) }, process.env);
  } else throw new Error("Usage: node .github/scripts/npm-release.mjs metadata|stage|published");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv[2]);
}
