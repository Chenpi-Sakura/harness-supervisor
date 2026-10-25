#!/usr/bin/env node
import { copyFile, readFile, stat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { atomicWriteJson } from "./util/fsx.js";
import { resolveStateDir } from "./ipc/protocol.js";

function quotePosix(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function quotePowerShell(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

export function codexNotificationHook(entry: string, stateDir: string) {
  return { hooks: [{
    type: "command",
    command: `node ${quotePosix(entry)} --state-dir ${quotePosix(stateDir)}`,
    commandWindows: `node ${quotePowerShell(entry)} --state-dir ${quotePowerShell(stateDir)}`,
    timeout: 5,
  }] };
}

/** Idempotent opt-in install. Preserves other hooks; does not trust or enable them. */
export async function installCodexNotificationHook(codexHome: string, stateDir: string, entry: string) {
  await stat(path.join(codexHome, "config.toml")); // Do not create a half-configured Codex profile.
  await stat(entry);
  const file = path.join(codexHome, "hooks.json");
  let raw: string | undefined;
  try { raw = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const config = raw === undefined ? {} : JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("hooks.json must be an object");
  config.hooks ??= {};
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) throw new Error("Invalid hooks object");
  config.hooks.UserPromptSubmit ??= [];
  const groups = config.hooks.UserPromptSubmit;
  if (!Array.isArray(groups)) throw new Error("UserPromptSubmit must be an array");
  const definition = codexNotificationHook(entry, stateDir);
  const expected = definition.hooks[0]!;
  if (groups.some(group => group && Array.isArray(group.hooks) && group.hooks.some((hook: Record<string, unknown>) =>
    hook?.type === "command" && hook.command === expected.command && hook.commandWindows === expected.commandWindows))) {
    return { changed: false, file };
  }
  if (groups.some(group => group && Array.isArray(group.hooks) && group.hooks.some((hook: Record<string, unknown>) =>
    [hook?.command,hook?.commandWindows].some(value => typeof value === "string" && /codex-notification-hook\.js|harness-supervisor-codex-hook/.test(value))))) {
    throw new Error("An HS notification hook with a different entry/state already exists; review the old definition in /hooks before replacing it");
  }
  const backup = raw === undefined ? undefined : `${file}.hs-backup-${Date.now()}-${randomUUID()}`;
  if (backup) await copyFile(file, backup, constants.COPYFILE_EXCL);
  // Do not silently overwrite a user edit made while preparing the merge.
  const current = await readFile(file,"utf8").catch((error: NodeJS.ErrnoException) => {if(error.code==="ENOENT")return undefined;throw error;});
  if (current !== raw) throw new Error("hooks.json changed during installation; retry after reviewing the concurrent edit");
  groups.push(definition);
  await atomicWriteJson(file, config);
  return { changed: true, file, backup };
}

// npm's POSIX bin entry can be a symlink; compare real paths, not argv spelling.
const invokedEntry = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedEntry && import.meta.url === pathToFileURL(invokedEntry).href) {
  try {
    const {values} = parseArgs({options:{install:{type:"boolean"}, "codex-home":{type:"string"}, "state-dir":{type:"string"}}});
    const entry = fileURLToPath(new URL("./codex-notification-hook.js", import.meta.url));
    const stateDir = resolveStateDir(values["state-dir"]);
    if (!values.install) {
      process.stdout.write(JSON.stringify({hooks:{UserPromptSubmit:[codexNotificationHook(entry,stateDir)]}},null,2)+"\n");
    } else {
      const codexHome = path.resolve(values["codex-home"] ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
      const result = await installCodexNotificationHook(codexHome,stateDir,entry);
      process.stdout.write(JSON.stringify({...result,next:"Review and trust this exact hook using /hooks in Codex; trust is never bypassed by this installer."})+"\n");
    }
  } catch (error) {
    process.stderr.write(`HS hook installation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode=1;
  }
}
