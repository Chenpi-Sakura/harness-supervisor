import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, "dist"), { recursive: true });
for (const name of ["index.js", "bridge.js", "node-runtime.js", "state-dir.js", "core-source.js", "source-binding.js"]) await copyFile(path.join(root, "src", name), path.join(root, "dist", name));
const client = await readFile(path.join(root, "src/client.cjs"), "utf8");
// DSH 0.2.2 public client bundle format, using only host-provided React.
await writeFile(path.join(root, "dist/client.js"), `window.__ModuleLoader__.load({\n  id: "dsh-harness-supervisor",\n  factory: (require) => {\n    const module = { exports: {} };\n    const exports = module.exports;\n${client}\n    return module.exports;\n  }\n});\n`);
