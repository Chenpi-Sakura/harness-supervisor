import os from "node:os";
import path from "node:path";

/** DSH has its own durable instance; global CLI environment settings do not select it. */
export function resolvePluginState(config = {}, env = process.env, home = os.homedir()) {
  const namespace = path.resolve(env.DSH_HOME || path.join(home, ".dsh"));
  const stateDir = path.resolve(config.stateDir || path.join(namespace, "harness-supervisor"));
  const globalDirs = [path.resolve(home, ".harness-supervisor"), path.resolve(env.HARNESS_SUPERVISOR_HOME || path.join(home, ".harness-supervisor"))];
  const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
  if (globalDirs.some(directory => normalize(directory) === normalize(stateDir))) {
    throw new Error("The DSH plugin requires a dedicated stateDir. Remove the shared directory setting to use DSH's bundled-core instance.");
  }
  return { namespace, stateDir };
}
