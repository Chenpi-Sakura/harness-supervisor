import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile, readdir} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {codexNotificationHook,installCodexNotificationHook} from "../../src/install-codex-notification-hook.js";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

test("installer executable prints a reviewable definition without installing by default", async () => {
  const entry=fileURLToPath(new URL("../../src/install-codex-notification-hook.js",import.meta.url));
  const child=spawn(process.execPath,[entry,"--state-dir","D:/explicit-state"],{stdio:["ignore","pipe","pipe"],windowsHide:true});
  let output="",error="";child.stdout.on("data",chunk=>output+=chunk);child.stderr.on("data",chunk=>error+=chunk);
  const code=await new Promise(resolve=>child.on("close",resolve));
  assert.equal(code,0,error);
  const definition=JSON.parse(output);
  assert.equal(definition.hooks.UserPromptSubmit[0].hooks[0].type,"command");
  assert.ok(definition.hooks.UserPromptSubmit[0].hooks[0].commandWindows.includes("explicit-state"));
});

test("opt-in install preserves other hooks, backs up config and is idempotent without granting trust", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"hs-hook-install-"));
  const config=path.join(dir,"config.toml"), entry=path.join(dir,"hook.js");
  await writeFile(config,"model='existing'\n");await writeFile(entry,"// fixture\n");
  const existing={description:"existing user setup",hooks:{Stop:[{hooks:[{type:"command",command:"existing-stop"}]}],UserPromptSubmit:[{hooks:[{type:"command",command:"existing-submit"}]}]}};
  const text=JSON.stringify(existing);
  await writeFile(path.join(dir,"hooks.json"),text);
  const first=await installCodexNotificationHook(dir,path.join(dir,"hs state"),entry);
  assert.equal(first.changed,true);assert.ok(first.backup);
  assert.equal(await readFile(first.backup!,"utf8"),text);
  const installed=JSON.parse(await readFile(first.file,"utf8"));
  assert.deepEqual(installed.hooks.Stop,existing.hooks.Stop);
  assert.deepEqual(installed.hooks.UserPromptSubmit[0],existing.hooks.UserPromptSubmit[0]);
  assert.equal(installed.hooks.UserPromptSubmit.length,2);
  assert.equal(await readFile(config,"utf8"),"model='existing'\n");
  const second=await installCodexNotificationHook(dir,path.join(dir,"hs state"),entry);
  assert.equal(second.changed,false);
  assert.equal((await readdir(dir)).filter(name=>name.includes("backup")).length,1);
  assert.equal((await readdir(dir)).some(name=>name.includes("trust")),false);
  // A changed state/path must not accumulate active copies of the same gate.
  // Use the real gate filename here; the fixture above deliberately uses hook.js.
  const realEntry=path.join(dir,"codex-notification-hook.js");await writeFile(realEntry,"//fixture");
  const other=await mkdtemp(path.join(os.tmpdir(),"hs-hook-change-"));await writeFile(path.join(other,"config.toml"),"");
  await installCodexNotificationHook(other,"state-one",realEntry);
  const before=await readFile(path.join(other,"hooks.json"),"utf8");
  await assert.rejects(installCodexNotificationHook(other,"state-two",realEntry),/different entry\/state/);
  assert.equal(await readFile(path.join(other,"hooks.json"),"utf8"),before);
});

test("invalid user config is not overwritten and shell paths stay literal", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"hs-hook-bad-"));
  const entry=path.join(dir,"hook.js");await writeFile(entry,"//fixture");await writeFile(path.join(dir,"config.toml"),"");
  await writeFile(path.join(dir,"hooks.json"),"{invalid");
  await assert.rejects(installCodexNotificationHook(dir,dir,entry));
  assert.equal(await readFile(path.join(dir,"hooks.json"),"utf8"),"{invalid");
  const hook=codexNotificationHook("D:/user's $dir/hook.js","D:/state`name").hooks[0]!;
  assert.ok(hook.commandWindows.includes("'D:/user''s $dir/hook.js'"));
  assert.ok(hook.commandWindows.includes("'D:/state`name'"));
  assert.equal(hook.timeout,5);
});
