#!/usr/bin/env node
// Real runtime regression: commentary -> actual tool side effect -> final reply.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, mkdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SupervisorClient} from '../dist/src/ipc/client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = await mkdtemp(path.join(os.tmpdir(), 'hs-final-state-'));
const cwd = await mkdtemp(path.join(os.tmpdir(), 'hs-final-work-'));
const evidenceDir = process.env.MCODE_EVIDENCE_DIR ? path.resolve(process.env.MCODE_EVIDENCE_DIR) : stateDir;
assert.ok(process.env.HARNESS_SUPERVISOR_MCODE_ENTRY, 'Set HARNESS_SUPERVISOR_MCODE_ENTRY to the native CLI entry');
const daemon = spawn(process.execPath, [path.join(root, 'dist/src/daemon-entry.js'), '--state-dir', stateDir], {
  env: {...process.env, HARNESS_SUPERVISOR_HOME: stateDir},
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
// Consume diagnostics without retaining native/private session material.
daemon.stdout.resume(); daemon.stderr.resume();
let client;
let workerId;
const evidence = {runtime: 'mcode', startedAt: new Date().toISOString(), result: 'failed'};
try {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const candidate = new SupervisorClient({stateDir, autoStart: false});
    try {await candidate.connect(); client = candidate; break;}
    catch {candidate.close(); await new Promise(r => setTimeout(r, 150));}
  }
  assert.ok(client, 'isolated daemon must become ready');
  const worker = await client.request('spawn', {
    runtime: 'mcode', cwd, maxDurationMs: 180000, notifyTarget: {channel: 'none'},
    prompt: 'First send a short progress commentary containing exactly NOISE_PROGRESS_ONLY. Then use a shell tool to write FINAL_TOOL_OK into proof.txt in the current directory. After the tool succeeds, your final reply must be exactly FINAL_REPORT_OK, with no other text. Do not mention the progress marker in the final reply.',
  }, {timeoutMs: 60000});
  workerId = worker.id;
  let cursor = worker.lastSeq;
  let final;
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const result = await client.request('wait', {workerId, sinceSeq: cursor, timeoutMs: 10000, until: 'terminal'});
    cursor = result.nextSeq;
    assert.notEqual(result.worker.status, 'awaiting_input', 'Use explicitly authorized native permission mode for this deterministic regression');
    if (result.terminal) {final = result.worker; break;}
  }
  assert.equal(final?.status, 'completed');
  assert.equal(final.result.text.trim(), 'FINAL_REPORT_OK', 'result must contain the final message only');
  assert.equal((await readFile(path.join(cwd, 'proof.txt'), 'utf8')).trim(), 'FINAL_TOOL_OK');
  let seq = 0;
  const events = [];
  for (;;) {
    const page = await client.request('events', {workerId, sinceSeq: seq, limit: 500});
    events.push(...page.events); seq = page.nextSeq;
    if (!page.hasMore) break;
  }
  assert.ok(events.some(e => e.type === 'run.progress' && e.data?.preview?.includes('NOISE_PROGRESS_ONLY')), 'commentary must remain observable in progress');
  assert.ok(events.some(e => e.type === 'run.progress' && e.data?.kind === 'tool_start'));
  evidence.result = 'passed';
  evidence.status = final.status;
  evidence.finalText = final.result.text;
  evidence.commentaryRecorded = true;
  evidence.toolSideEffectVerified = true;
  console.log(JSON.stringify(evidence));
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(evidence.error);
} finally {
  try {
    if (client && workerId) await client.request('cancel', {workerId}, {timeoutMs: 20000}).catch(() => undefined);
    await client?.shutdown();
  } finally {
    client?.close();
    daemon.kill();
    evidence.finishedAt = new Date().toISOString();
    await mkdir(evidenceDir, {recursive: true});
    await writeFile(path.join(evidenceDir, 'mcode-final-message-e2e.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
}
