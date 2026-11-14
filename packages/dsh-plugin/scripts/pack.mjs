import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyProductionTree } from "../../../scripts/verify-production-tree.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv.indexOf("--core-tarball");
if (arg >= 0 && !process.argv[arg + 1]) throw new Error("Usage: node scripts/pack.mjs [--core-tarball <harness-supervisor-0.12.2.tgz>]");
const tarball = path.resolve(arg >= 0 ? process.argv[arg + 1] : path.join(root, "../../.artifacts/harness-supervisor-0.12.2.tgz"));
const output = path.join(root, ".artifacts");
await mkdir(output, { recursive: true });
await import("./build.mjs");
const stage = await mkdtemp(path.join(output, "package-"));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await writeFile(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2));
for (const name of ["dist", "cordis.patch.yml", "README.md", "LICENSE"]) await cp(path.join(root, name), path.join(stage, name), { recursive: true });
const npmCli = [process.env.npm_execpath, process.env.NPM_CLI_PATH, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")]
  .find((candidate) => candidate && candidate.endsWith(".js") && existsSync(candidate));
if (!npmCli) throw new Error("Run through npm run pack:release or set NPM_CLI_PATH to npm-cli.js");
function run(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args, "--prefix", stage, "--workspaces=false"], { cwd: stage, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
// This is our verified release artifact, already carrying its locked dependency
// tree. Unpack it without re-resolving versions or running package scripts.
const tar = createRequire(npmCli)("tar");
const coreRoot = path.join(stage, "node_modules/harness-supervisor");
await mkdir(coreRoot, { recursive: true });
await tar.x({
  file: tarball, cwd: coreRoot, strip: 1, strict: true, preservePaths: false,
  filter(name, entry) {
    if (!(name.startsWith("package/") || name === "package") || name.includes("\\") || name.split("/").includes("..") || name.includes(":") || !["File", "Directory"].includes(entry.type)) {
      throw new Error(`Unsafe core archive entry: ${name}`);
    }
    return true;
  },
});
const core = JSON.parse(await readFile(path.join(stage, "node_modules/harness-supervisor/package.json"), "utf8"));
if (core.name !== "harness-supervisor" || core.version !== manifest.dependencies["harness-supervisor"]) throw new Error("The core artifact does not match the plugin's pinned version");
for (const name of ["dist/src/mcp.js", "dist/src/daemon-entry.js", "dist/web/index.html"]) await readFile(path.join(stage, "node_modules/harness-supervisor", name));
const productionLock = JSON.parse(await readFile(path.join(coreRoot, "production-lock.json"), "utf8"));
if (productionLock.version !== core.version || productionLock.lockfileVersion !== 3) throw new Error("A matching core production-lock.json is required");
await verifyProductionTree(path.join(stage, "node_modules"), productionLock, [`${core.name}@${core.version}`]);
// Remove temporary file specifiers: an installed plugin never refers to the build checkout.
await writeFile(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2));
const packedResult = JSON.parse(run(["pack", stage, "--ignore-scripts", "--json", "--pack-destination", output]));
const packed = Array.isArray(packedResult) ? packedResult[0] : Object.values(packedResult)[0];
const release = path.join(output, packed.filename);
const descriptor = { pluginVersion: manifest.version, coreVersion: core.version, tarball: path.basename(release), integrity: packed.integrity };
await writeFile(path.join(output, "release.json"), JSON.stringify(descriptor, null, 2));
console.log(JSON.stringify(descriptor, null, 2));
