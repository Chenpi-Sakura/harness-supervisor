import { lstat, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/** Release-time check shared by core and plugin packaging. */
export async function verifyProductionTree(modules, lock, extraPairs = []) {
  const expected = new Set([
    ...Object.entries(lock.packages).filter(([key, value]) => key && !value.dev).map(([key, value]) => `${value.name || key.slice(key.lastIndexOf("node_modules/") + 13)}@${value.version}`),
    ...extraPairs,
  ]);
  async function inspect(directory) {
    if ((await lstat(directory)).isSymbolicLink()) throw Error("Release dependencies cannot be checkout links");
    const installed = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    if (!expected.has(`${installed.name}@${installed.version}`)) throw Error(`Dependency ${installed.name}@${installed.version} differs from the verified production lock`);
    const req = createRequire(path.join(directory, "package.json"));
    for (const name of Object.keys(installed.dependencies ?? {})) {
      let found;
      for (const search of req.resolve.paths(name) ?? []) {
        try { found = JSON.parse(await readFile(path.join(search, name, "package.json"), "utf8")); break; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (!found || !expected.has(`${found.name}@${found.version}`)) throw Error(`Required dependency ${name} of ${installed.name} is missing or differs from the lock`);
    }
    await walk(path.join(directory, "node_modules"));
  }
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error("Release dependencies cannot be checkout links");
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) await walk(child);
      else await inspect(child);
    }
  }
  await walk(modules);
}
