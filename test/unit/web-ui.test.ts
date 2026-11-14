import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { SupervisorError } from "../../src/errors.js";
import type { Supervisor } from "../../src/supervisor.js";
import type { WorkerSummary } from "../../src/types.js";
import { WebUiServer, type WebUiLaunch } from "../../src/web-ui.js";

function fakeSupervisor() {
  const base = { runtime: "pi", status: "awaiting_input", lifecycle: "awaiting_input", createdAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:00Z", cwd: "/test", promptPreview: "test", persistence: "persistent", taskId: "shared-task" };
  type FakeWorker = typeof base & { id: string; ownerRef?: string; pendingInput?: { requestId: string; method: string; title: string } };
  const workers = new Map<string, FakeWorker>([
    ["worker-a", { ...base, id: "worker-a", ownerRef: "dsh:session-a", pendingInput: { requestId: "input-current", method: "confirm", title: "Permission" } }],
    ["worker-b", { ...base, id: "worker-b", ownerRef: "dsh:session-b" }],
    ["worker-legacy", { ...base, id: "worker-legacy", ownerRef: undefined }],
  ]);
  let answers = 0;
  let cancels = 0;
  const supervisor = {
    store: { getWorker: (id: string) => workers.get(id), readPrompt: async (id: string) => ({ text: `# Full prompt for ${id}\n${"details ".repeat(100)}`, available: true }) },
    list: (filter: { ownerRef?: string; limit?: number }) => [...workers.values()].filter(worker => filter.ownerRef === undefined || worker.ownerRef === filter.ownerRef).slice(0, filter.limit ?? 100),
    status: async (id: string) => ({ worker: workers.get(id), recentEvents: [], stderrTail: "" }),
    events: async (id: string, options: { sinceSeq: number }) => ({ worker: workers.get(id), events: options.sinceSeq < 2 ? [{ seq: 2, workerId: id, type: "run.needs_input", ts: "2026-11-11T00:00:00Z" }] : [], nextSeq: Math.max(2, options.sinceSeq), hasMore: false }),
    metricsTask: () => ({ task: { title: "must not leak" }, usage: [
      { workerId: "worker-a", role: "worker", inputTokens: 42 },
      { workerId: "worker-b", role: "worker", inputTokens: 99 },
      { role: "parent_agent", inputTokens: 1000 },
    ] }),
    answer: async (id: string, requestId: string) => {
      const worker = workers.get(id)!;
      if (!worker.pendingInput || requestId !== worker.pendingInput.requestId) throw new SupervisorError("INVALID_STATE", "Stale input request");
      answers++;
      worker.pendingInput = undefined;
      worker.status = "running";
      return worker;
    },
    cancel: async (id: string) => {
      cancels++;
      const worker = workers.get(id)!;
      worker.status = "cancelled";
      return worker;
    },
  } as unknown as Supervisor;
  return { supervisor, counts: () => ({ answers, cancels }) };
}

function setup() {
  const fake = fakeSupervisor();
  const ui = new WebUiServer({ supervisor: fake.supervisor, staticDir: path.resolve("web"), port: 0 });
  return { ui, ...fake };
}

test("WebUI defaults to loopback port 61114", async (t) => {
  const ui = new WebUiServer({ supervisor: fakeSupervisor().supervisor, staticDir: path.resolve("web") });
  t.after(() => ui.stop());
  assert.equal(ui.status().running, false);
  const launch = await ui.launch();
  assert.equal(launch.origin, "http://127.0.0.1:61114");
});

test("enabling the listener creates no browser credentials and remains stoppable", async (t) => {
  const { ui } = setup();
  t.after(() => ui.stop());
  await Promise.all([ui.enable(), ui.enable()]);
  const origin = ui.status().origin!;
  assert.equal(ui.status().running, true);
  assert.equal((await fetch(`${origin}/api/session`)).status, 401);
  const launch = await ui.launch();
  assert.equal(launch.origin, origin);
  assert.equal((await exchange(launch)).response.status, 200);
  await ui.stop();
  assert.equal(ui.status().running, false);
  await Promise.all([ui.enable(), ui.stop()]);
  assert.equal(ui.status().running, false, "a queued stop must win over startup");
});

async function exchange(launch: WebUiLaunch) {
  const url = new URL(launch.url);
  const response = await fetch(`${url.origin}/api/exchange`, {
    method: "POST",
    headers: { Origin: url.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ launchToken: new URLSearchParams(url.hash.slice(1)).get("launch"), viewId: url.pathname.split("/")[2] }),
  });
  return { response, data: await response.json() as { token: string; ownerRef: string | null; preferredOwnerRef: string | null } };
}

test("WebUI starts only on launch, binds loopback and invalidates one-use links and sessions on stop", async (t) => {
  const { ui } = setup();
  t.after(() => ui.stop());
  assert.deepEqual(ui.status(), { running: false });
  const launch = await ui.launch({ ownerRef: "dsh:session-a" });
  assert.equal(new URL(launch.url).hostname, "127.0.0.1");
  assert.ok(Date.parse(launch.expiresAt) > Date.now());
  const page = await fetch(launch.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'self'/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("set-cookie"), null);
  const { response, data } = await exchange(launch);
  assert.equal(response.status, 200);
  assert.equal(data.ownerRef, "dsh:session-a");
  assert.ok(data.token);
  assert.equal((await exchange(launch)).response.status, 401);
  const session = await fetch(`${launch.origin}/api/session`, { headers: { Authorization: `Bearer ${data.token}` } });
  assert.equal(session.status, 200);
  await ui.stop();
  assert.deepEqual(ui.status(), { running: false });
  const reopened = await ui.launch();
  assert.equal((await fetch(`${reopened.origin}/api/session`, { headers: { Authorization: `Bearer ${data.token}` } })).status, 401);
});

test("WebUI enforces owner scope on list, status, events, usage, answer and cancel", async (t) => {
  const { ui, counts } = setup();
  t.after(() => ui.stop());
  const launch = await ui.launch({ ownerRef: "dsh:session-a" });
  const { data } = await exchange(launch);
  const headers = { Authorization: `Bearer ${data.token}` };
  const postHeaders = { ...headers, Origin: launch.origin, "Content-Type": "application/json" };
  const list = await fetch(`${launch.origin}/api/workers`, { headers }).then(r => r.json()) as { workers: WorkerSummary[] };
  assert.deepEqual(list.workers.map(w => w.id), ["worker-a"]);
  for (const id of ["worker-b", "worker-legacy", "nonexistent"]) {
    for (const action of ["status", "events", "usage", "prompt"]) {
      assert.equal((await fetch(`${launch.origin}/api/workers/${id}/${action}`, { headers })).status, 404);
    }
    for (const action of ["answer", "cancel"]) {
      assert.equal((await fetch(`${launch.origin}/api/workers/${id}/${action}`, { method: "POST", headers: postHeaders, body: "{}" })).status, 404);
    }
  }
  assert.deepEqual(counts(), { answers: 0, cancels: 0 });
  const prompt = await fetch(`${launch.origin}/api/workers/worker-a/prompt`, { headers }).then(r => r.json()) as { text: string; available: boolean };
  assert.equal(prompt.available, true);
  assert.ok(prompt.text.length > 500);
  const usage = await fetch(`${launch.origin}/api/workers/worker-a/usage`, { headers }).then(r => r.json());
  assert.deepEqual(usage, { available: true, usage: [{ workerId: "worker-a", role: "worker", inputTokens: 42 }] });
  const events = await fetch(`${launch.origin}/api/workers/worker-a/events?sinceSeq=2`, { headers }).then(r => r.json()) as { events: unknown[]; nextSeq: number };
  assert.equal(events.events.length, 0);
  assert.equal(events.nextSeq, 2);
  const answerUrl = `${launch.origin}/api/workers/worker-a/answer`;
  const answerBody = JSON.stringify({ requestId: "input-current", response: { confirmed: true } });
  assert.equal((await fetch(answerUrl, { method: "POST", headers: postHeaders, body: answerBody })).status, 200);
  assert.equal((await fetch(answerUrl, { method: "POST", headers: postHeaders, body: answerBody })).status, 409);
  assert.equal((await fetch(`${launch.origin}/api/workers/worker-a/cancel`, { method: "POST", headers: postHeaders, body: "{}" })).status, 200);
  assert.deepEqual(counts(), { answers: 1, cancels: 1 });
  const global = await ui.launch();
  const globalToken = (await exchange(global)).data.token;
  const globalList = await fetch(`${global.origin}/api/workers`, { headers: { Authorization: `Bearer ${globalToken}` } }).then(r => r.json()) as { workers: WorkerSummary[] };
  assert.equal(globalList.workers.length, 3);
});

test("global human views prefer the current conversation without hiding other or legacy Workers", async (t) => {
  const { ui, counts } = setup();
  t.after(() => ui.stop());
  const launch = await ui.launch({ preferredOwnerRef: "dsh:session-b" });
  const auth = (await exchange(launch)).data;
  assert.equal(auth.ownerRef, null);
  assert.equal(auth.preferredOwnerRef, "dsh:session-b");
  const headers = { Authorization: `Bearer ${auth.token}` };
  const identity = await fetch(`${launch.origin}/api/session`, { headers }).then(r => r.json()) as { ownerRef: string | null; preferredOwnerRef: string | null };
  assert.equal(identity.ownerRef, null);
  assert.equal(identity.preferredOwnerRef, "dsh:session-b");
  const first = await fetch(`${launch.origin}/api/workers?limit=1`, { headers }).then(r => r.json()) as { workers: WorkerSummary[]; preferredWorkers: WorkerSummary[]; hasMore: boolean };
  assert.deepEqual(first.workers.map((worker: WorkerSummary) => worker.id), ["worker-a"]);
  assert.deepEqual(first.preferredWorkers.map((worker: WorkerSummary) => worker.id), ["worker-b"], "current-session Workers are returned even beyond global page one");
  assert.equal(first.hasMore, true);
  const all = await fetch(`${launch.origin}/api/workers`, { headers }).then(r => r.json()) as { workers: WorkerSummary[] };
  assert.deepEqual(all.workers.map((worker: WorkerSummary) => worker.id), ["worker-a", "worker-b", "worker-legacy"]);
  for (const id of ["worker-a", "worker-b", "worker-legacy"]) {
    assert.equal((await fetch(`${launch.origin}/api/workers/${id}/status`, { headers })).status, 200);
  }
  const postHeaders = { ...headers, Origin: launch.origin, "Content-Type": "application/json" };
  assert.equal((await fetch(`${launch.origin}/api/workers/worker-a/answer`, { method: "POST", headers: postHeaders, body: JSON.stringify({ requestId: "input-current", response: { confirmed: true } }) })).status, 200);
  assert.equal((await fetch(`${launch.origin}/api/workers/worker-b/cancel`, { method: "POST", headers: postHeaders, body: "{}" })).status, 200);
  assert.deepEqual(counts(), { answers: 1, cancels: 1 });
  await assert.rejects(() => ui.launch({ ownerRef: "dsh:session-a", preferredOwnerRef: "dsh:session-b" }), /authorized owner/);
  const scoped = await ui.launch({ ownerRef: "dsh:session-a" });
  const scopedAuth = (await exchange(scoped)).data;
  assert.equal(scopedAuth.preferredOwnerRef, "dsh:session-a");
  assert.equal((await fetch(`${scoped.origin}/api/workers/worker-b/status`, { headers: { Authorization: `Bearer ${scopedAuth.token}` } })).status, 404);
});

test("late panel generations cannot revoke a newer global view or change its preference", async (t) => {
  const { ui } = setup();
  t.after(() => ui.stop());
  const latest = await ui.launch({ preferredOwnerRef: "dsh:session-b", viewKey: "same-panel", viewGeneration: 2 });
  const token = (await exchange(latest)).data.token;
  const headers = { Authorization: `Bearer ${token}` };
  const read = () => fetch(`${latest.origin}/api/session`, { headers });
  for (const viewGeneration of [1, 2, undefined]) {
    await assert.rejects(() => ui.launch({ preferredOwnerRef: "dsh:session-a", viewKey: "same-panel", viewGeneration }), (error: unknown) => error instanceof SupervisorError && error.code === "CONFLICT");
    assert.equal((await read()).status, 200);
  }
  const identity = await (await read()).json() as { preferredOwnerRef: string | null };
  assert.equal(identity.preferredOwnerRef, "dsh:session-b");
  for (const viewGeneration of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => ui.launch({ viewKey: "same-panel", viewGeneration }));
    assert.equal((await read()).status, 200);
  }
  await assert.rejects(() => ui.launch({ viewGeneration: 3 }));
  const next = await ui.launch({ preferredOwnerRef: "dsh:session-a", viewKey: "same-panel", viewGeneration: 3 });
  assert.equal((await read()).status, 401);
  const nextAuth = (await exchange(next)).data;
  assert.equal(nextAuth.preferredOwnerRef, "dsh:session-a");
  assert.equal(nextAuth.ownerRef, null);
});

test("WebUI rejects cross-origin, unauthenticated, generic proxy, malformed and DNS rebinding requests", async (t) => {
  const { ui, counts } = setup();
  t.after(() => ui.stop());
  const launch = await ui.launch();
  const token = (await exchange(launch)).data.token;
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${launch.origin}/api/workers`)).status, 401);
  assert.equal((await fetch(`${launch.origin}/api/workers`, { headers: { ...headers, Origin: "https://malicious.invalid" } })).status, 401);
  assert.equal((await fetch(`${launch.origin}/api/workers/worker-a/cancel`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" })).status, 401);
  for (const route of ["/api/spawn", "/api/shutdown", "/api/notification_ack", "/api/ipc", "/api/workers/worker-a/continue", "/src/web-ui.ts", "/assets/../package.json"]) {
    assert.equal((await fetch(`${launch.origin}${route}`, { headers })).status, 404);
  }
  for (const query of ["?limit=0", "?limit=501", "?limit=nan", "?afterId=worker-a"]) {
    assert.equal((await fetch(`${launch.origin}/api/workers${query}`, { headers })).status, 400);
  }
  const rebindingStatus = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${launch.origin}/api/workers`, { headers: { ...headers, Host: "malicious.invalid" } }, response => {
      response.resume();
      resolve(response.statusCode!);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(rebindingStatus, 401);
  const body = JSON.stringify({ extra: true });
  assert.equal((await fetch(`${launch.origin}/api/workers/worker-a/cancel`, { method: "POST", headers: { ...headers, Origin: launch.origin, "Content-Type": "application/json" }, body })).status, 400);
  assert.deepEqual(counts(), { answers: 0, cancels: 0 });
});

test("WebUI pins distinct launch scopes and exact iframe origins without wildcard CORS", async (t) => {
  const { ui } = setup();
  t.after(() => ui.stop());
  for (const frameOrigin of ["*", "null", "https://example.com/", "https://example.com/path", "file://", "https://example.com;script-src *", "dsh-app://evil", "dsh-app://app/", "dsh-app://app.evil", "dsh-app://app;script-src *"]) {
    await assert.rejects(() => ui.launch({ frameOrigin }));
  }
  assert.equal(ui.status().running, false, "invalid launch must not open an HTTP listener");
  const a = await ui.launch({ ownerRef: "dsh:session-a", frameOrigin: "http://127.0.0.1:3080" });
  const b = await ui.launch({ ownerRef: "dsh:session-b", frameOrigin: "https://dsh.example.com" });
  assert.notEqual(new URL(a.url).pathname, new URL(b.url).pathname);
  const pageA = await fetch(a.url);
  const pageB = await fetch(b.url);
  assert.equal(pageA.headers.get("access-control-allow-origin"), null);
  assert.match(pageA.headers.get("content-security-policy")!, /frame-ancestors 'self' http:\/\/127\.0\.0\.1:3080/);
  assert.doesNotMatch(pageA.headers.get("content-security-policy")!, /dsh\.example\.com/);
  assert.match(pageB.headers.get("content-security-policy")!, /frame-ancestors 'self' https:\/\/dsh\.example\.com/);
  const authA = (await exchange(a)).data;
  const authB = (await exchange(b)).data;
  assert.equal(authA.ownerRef, "dsh:session-a");
  assert.equal(authB.ownerRef, "dsh:session-b");
  const aSession = await fetch(`${a.origin}/api/session`, { headers: { Authorization: `Bearer ${authA.token}` } }).then(r => r.json()) as { ownerRef: string };
  assert.equal(aSession.ownerRef, "dsh:session-a", "opening another scope must not retarget old credentials");
});

test("WebUI permits only the exact DSH Desktop frame ancestor without relaxing API origins", async (t) => {
  const { ui, counts } = setup();
  t.after(() => ui.stop());
  const launch = await ui.launch({ ownerRef: "dsh:session-a", frameOrigin: "dsh-app://app" });
  const page = await fetch(launch.url);
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'self' dsh-app:\/\/app(?:;|$)/);
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  const auth = (await exchange(launch)).data;
  for (const Origin of ["dsh-app://app", "null"]) {
    const response = await fetch(`${launch.origin}/api/workers/worker-a/cancel`, {
      method: "POST", headers: { Origin, Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 401);
  }
  assert.deepEqual(counts(), { answers: 0, cancels: 0 });
});

test("reopening a host panel replaces its credentials without exhausting capacity or revoking other views", async (t) => {
  const { ui } = setup();
  t.after(() => ui.stop());
  const anotherWindow = await ui.launch({ ownerRef: "dsh:session-a", viewKey: "other-window" });
  const anotherOwner = await ui.launch({ ownerRef: "dsh:session-b", viewKey: "main-panel" });
  const otherTokens = [(await exchange(anotherWindow)).data.token, (await exchange(anotherOwner)).data.token];
  let firstToken = "", firstUrl = "", lastToken = "";
  for (let i = 0; i < 260; i++) {
    const launch = await ui.launch({ ownerRef: "dsh:session-a", viewKey: "main-panel" });
    const token = (await exchange(launch)).data.token;
    if (i === 0) { firstToken = token; firstUrl = launch.url; }
    lastToken = token;
  }
  const session = (token: string) => fetch(`${anotherWindow.origin}/api/session`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await session(firstToken)).status, 401);
  assert.equal((await fetch(firstUrl)).status, 404);
  assert.equal((await session(lastToken)).status, 200);
  for (const token of otherTokens) assert.equal((await session(token)).status, 200);
  const unused = await ui.launch({ ownerRef: "dsh:session-a", viewKey: "main-panel" });
  const replacement = await ui.launch({ ownerRef: "dsh:session-a", viewKey: "main-panel" });
  assert.equal((await exchange(unused)).response.status, 401);
  assert.equal((await exchange(replacement)).response.status, 200);
  await assert.rejects(() => ui.launch({ viewKey: "x".repeat(201) }));
});

test("WebUI expires unused launch links and session credentials and serializes launch/stop races", async (t) => {
  const { ui } = setup();
  t.after(() => ui.stop());
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const expired = await ui.launch();
  now += 60_001;
  assert.equal((await exchange(expired)).response.status, 401);
  const fresh = await ui.launch();
  const token = (await exchange(fresh)).data.token;
  now += 8 * 60 * 60_000 + 1;
  assert.equal((await fetch(`${fresh.origin}/api/session`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  await ui.stop();
  const first = ui.launch();
  const stopping = ui.stop();
  const last = ui.launch({ ownerRef: "dsh:session-b" });
  await Promise.all([first, stopping]);
  const final = await last;
  assert.equal(ui.status().origin, final.origin);
  assert.equal((await exchange(final)).data.ownerRef, "dsh:session-b");
});

test("WebUI accepts a full multibyte answer while rejecting oversized bodies before mutation", async (t) => {
  const { ui, supervisor, counts } = setup();
  t.after(() => ui.stop());
  supervisor.store.getWorker("worker-a")!.pendingInput!.method = "input";
  const launch = await ui.launch({ ownerRef: "dsh:session-a" });
  const token = (await exchange(launch)).data.token;
  const headers = { Authorization: `Bearer ${token}`, Origin: launch.origin, "Content-Type": "application/json" };
  const url = `${launch.origin}/api/workers/worker-a/answer`;
  const huge = await fetch(url, { method: "POST", headers, body: JSON.stringify({ requestId: "input-current", response: { value: "中".repeat(200_000) } }) });
  assert.equal(huge.status, 400);
  assert.equal(counts().answers, 0);
  const allowed = await fetch(url, { method: "POST", headers, body: JSON.stringify({ requestId: "input-current", response: { value: "中".repeat(64 * 1024) } }) });
  assert.equal(allowed.status, 200);
  assert.equal(counts().answers, 1);
});
