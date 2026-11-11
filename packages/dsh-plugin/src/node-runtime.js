import { existsSync } from "node:fs";
import path from "node:path";

/** Desktop's Electron executable needs its own flags; use its shipped Node instead. */
export function resolveNodeExecutable(explicit, runtime = process) {
  if (explicit) {
    if (!path.isAbsolute(explicit) || !existsSync(explicit) || /\.(?:cmd|bat|ps1)$/i.test(explicit)) {
      throw new Error("nodeExecutable must name an existing absolute Node executable, not a shell shim");
    }
    return explicit;
  }
  if (!runtime.versions.electron) return runtime.execPath;
  const resources = runtime.resourcesPath || path.join(path.dirname(runtime.execPath), "resources");
  const shipped = path.join(resources, "runtime/primary-runtime/dependencies/node/bin", runtime.platform === "win32" ? "node.exe" : "node");
  if (existsSync(shipped)) return shipped;
  throw new Error("The DSH Desktop Node runtime was not found. Configure nodeExecutable with Node >=22.19; HS will not launch Electron as a daemon.");
}
