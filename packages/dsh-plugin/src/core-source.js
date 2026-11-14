import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export function validateCoreRoot(root) {
  if (!path.isAbsolute(root)) throw new Error("HS 安装目录必须是绝对路径");
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (manifest.name !== "harness-supervisor") throw new Error("所选目录不是 harness-supervisor 安装目录");
  for (const file of ["dist/src/daemon-entry.js", "dist/src/mcp.js", "dist/web/index.html"]) {
    if (!existsSync(path.join(root, file))) throw new Error(`HS 安装不完整，缺少 ${file}；源码目录请先构建`);
  }
  return root;
}

export function findGlobalCore(nodeExecutable, env = process.env, run = execFileSync) {
  const directories = [path.dirname(nodeExecutable), ...(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)];
  const candidates = [env.npm_execpath];
  for (const directory of directories) {
    candidates.push(path.join(directory, "node_modules/npm/bin/npm-cli.js"));
    const npm = path.join(directory, "npm");
    try { candidates.push(realpathSync(npm)); } catch { /* Not a Unix npm symlink. */ }
  }
  if (env.APPDATA) candidates.push(path.join(env.APPDATA, "npm/node_modules/npm/bin/npm-cli.js"));
  const cli = candidates.find(file => file && path.basename(file) === "npm-cli.js" && existsSync(file));
  if (!cli) throw new Error("未找到 npm，请安装 Node.js/npm，或选择自定义 HS 安装目录");
  const globalRoot = run(nodeExecutable, [cli, "root", "--global"], {
    env, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
  }).trim();
  if (!path.isAbsolute(globalRoot) || globalRoot.includes("\n")) throw new Error("npm 未返回有效的全局安装目录");
  if (!existsSync(path.join(globalRoot, "harness-supervisor/package.json"))) {
    throw new Error("未找到全局 HS，请先运行 npm install -g harness-supervisor，或选择自定义安装目录");
  }
  return validateCoreRoot(path.join(globalRoot, "harness-supervisor"));
}
