import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SupervisorError, serializeError } from "./errors.js";
import { OwnerRefSchema } from "./ipc/protocol.js";
import type { Supervisor } from "./supervisor.js";
import type { WorkerSummary } from "./types.js";
import { VERSION } from "./version.js";

const LAUNCH_TTL_MS = 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_CREDENTIALS = 256;
// A valid 64K-character answer can use six JSON bytes per escaped character.
const MAX_BODY_BYTES = 512 * 1024;
const IdSchema = z.string().min(1).max(200);
const AnswerSchema = z.object({
  requestId: z.string().min(1).max(500),
  response: z.union([
    z.object({ value: z.string().max(64 * 1024) }).strict(),
    z.object({ confirmed: z.boolean() }).strict(),
    z.object({ cancelled: z.literal(true) }).strict(),
  ]),
}).strict();

interface Credential {
  viewId: string;
  ownerRef?: string;
  preferredOwnerRef?: string;
  frameOrigin?: string;
  expires: number;
}

export interface WebUiLaunchOptions {
  /** Omitted only for the global human-operator entry point. */
  ownerRef?: string;
  /** Presentation preference only; it never grants or restricts Worker access. */
  preferredOwnerRef?: string;
  /** Exact trusted embedding origin, including DSH Desktop's application scheme. */
  frameOrigin?: string;
  /** Stable per-host-panel key. Reopening revokes only this panel's old view. */
  viewKey?: string;
  /** Monotonic within a host panel; stale requests cannot revoke a newer view. */
  viewGeneration?: number;
}

export interface WebUiLaunch {
  url: string;
  origin: string;
  ownerRef?: string;
  preferredOwnerRef?: string;
  expiresAt: string;
}

export interface WebUiOptions {
  supervisor: Supervisor;
  staticDir?: string;
  /** Primarily for isolated tests; production uses an ephemeral loopback port. */
  port?: number;
}

function secret(): string {
  return randomBytes(32).toString("hex");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function frameOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // DSH Desktop's registered application origin is opaque to URL.origin. Only
  // this exact host is accepted; it grants framing, never cross-origin API use.
  if (value === "dsh-app://app") return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SupervisorError("BAD_REQUEST", "frameOrigin must be an exact HTTP(S) origin");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value || url.username || url.password) {
    throw new SupervisorError("BAD_REQUEST", "frameOrigin must be an exact HTTP(S) origin");
  }
  return url.origin;
}

function queryInt(url: URL, name: string, fallback: number, max: number): number {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new SupervisorError("BAD_REQUEST", `Invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new SupervisorError("BAD_REQUEST", `Invalid ${name}`);
  }
  return parsed;
}

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new SupervisorError("BAD_REQUEST", "application/json is required");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new SupervisorError("BAD_REQUEST", "Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SupervisorError("BAD_REQUEST", "Invalid JSON body");
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SupervisorError("BAD_REQUEST", "Invalid request parameters");
  return parsed.data;
}

/** Optional HTTP surface over the same Supervisor; it owns no Worker state. */
export class WebUiServer {
  private readonly options: WebUiOptions;
  private server?: http.Server;
  private origin?: string;
  private operations: Promise<unknown> = Promise.resolve();
  private readonly launches = new Map<string, Credential>();
  private readonly sessions = new Map<string, Credential>();
  private readonly views = new Map<string, Credential>();
  private readonly panelViews = new Map<string, string>();
  private readonly panelGenerations = new Map<string, number>();

  constructor(options: WebUiOptions) {
    this.options = options;
  }

  status(): { running: boolean; origin?: string } {
    return { running: this.server !== undefined, ...(this.origin ? { origin: this.origin } : {}) };
  }

  launch(options: WebUiLaunchOptions = {}): Promise<WebUiLaunch> {
    return this.exclusive(async () => {
      const ownerRef = options.ownerRef === undefined ? undefined : parse(OwnerRefSchema, options.ownerRef);
      const preferredOwnerRef = options.preferredOwnerRef === undefined ? ownerRef : parse(OwnerRefSchema, options.preferredOwnerRef);
      if (ownerRef !== undefined && preferredOwnerRef !== ownerRef) {
        throw new SupervisorError("BAD_REQUEST", "A scoped WebUI preference must match its authorized owner");
      }
      const embeddingOrigin = frameOrigin(options.frameOrigin);
      const viewKey = options.viewKey === undefined ? undefined : parse(IdSchema, options.viewKey);
      const generation = options.viewGeneration === undefined ? undefined : parse(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), options.viewGeneration);
      if (generation !== undefined && viewKey === undefined) throw new SupervisorError("BAD_REQUEST", "viewGeneration requires a viewKey");
      const panelKey = viewKey === undefined ? undefined : JSON.stringify([ownerRef ?? null, viewKey]);
      this.prune();
      const latestGeneration = panelKey === undefined ? undefined : this.panelGenerations.get(panelKey);
      if (latestGeneration !== undefined && (generation === undefined || generation <= latestGeneration)) {
        throw new SupervisorError("CONFLICT", "A newer WebUI panel request has already been accepted");
      }
      const previousView = panelKey === undefined ? undefined : this.panelViews.get(panelKey);
      if (previousView) {
        // A conversation tab is mounted again when selected. Replace its own
        // credentials instead of consuming another eight-hour session slot.
        for (const map of [this.launches, this.sessions]) {
          for (const [key, credential] of map) if (credential.viewId === previousView) map.delete(key);
        }
        this.views.delete(previousView);
        this.panelViews.delete(panelKey!);
      }
      if (this.launches.size + this.sessions.size >= MAX_CREDENTIALS) {
        throw new SupervisorError("LIMIT_EXCEEDED", "Too many open WebUI sessions; close or reopen later");
      }
      await this.start();
      const launchToken = secret();
      const viewId = randomBytes(16).toString("hex");
      const credential: Credential = {
        viewId,
        ownerRef,
        preferredOwnerRef,
        frameOrigin: embeddingOrigin,
        expires: Date.now() + LAUNCH_TTL_MS,
      };
      this.launches.set(digest(launchToken), credential);
      this.views.set(viewId, credential);
      if (panelKey !== undefined) this.panelViews.set(panelKey, viewId);
      if (panelKey !== undefined && generation !== undefined) this.panelGenerations.set(panelKey, generation);
      return {
        url: `${this.origin}/view/${viewId}/#launch=${launchToken}`,
        origin: this.origin!,
        ...(ownerRef ? { ownerRef } : {}),
        ...(preferredOwnerRef ? { preferredOwnerRef } : {}),
        expiresAt: new Date(credential.expires).toISOString(),
      };
    });
  }

  stop(): Promise<void> {
    return this.exclusive(async () => {
      const server = this.server;
      this.server = undefined;
      this.origin = undefined;
      this.launches.clear();
      this.sessions.clear();
      this.views.clear();
      this.panelViews.clear();
      this.panelGenerations.clear();
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.catch(() => undefined);
    return result;
  }

  private prune(): void {
    const now = Date.now();
    for (const map of [this.launches, this.sessions, this.views]) {
      for (const [key, credential] of map) if (credential.expires <= now) map.delete(key);
    }
    for (const [key, viewId] of this.panelViews) if (!this.views.has(viewId)) this.panelViews.delete(key);
    for (const key of this.panelGenerations.keys()) if (!this.panelViews.has(key)) this.panelGenerations.delete(key);
  }

  private async start(): Promise<void> {
    if (this.server) return;
    // Fail before opening a port when the optional frontend was not packaged.
    await readFile(path.join(this.staticDir(), "index.html"));
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => this.fail(res, error));
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 40;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new SupervisorError("INTERNAL", "WebUI did not acquire a loopback address");
    }
    server.on("error", () => undefined);
    this.server = server;
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  private staticDir(): string {
    return this.options.staticDir ?? fileURLToPath(new URL("../web/", import.meta.url));
  }

  private headers(res: ServerResponse, ancestor?: string): void {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors 'self'${ancestor ? ` ${ancestor}` : ""}`,
    ].join("; "));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.headers(res);
    const origin = this.origin;
    if (!origin || req.headers.host !== new URL(origin).host) {
      throw new SupervisorError("UNAUTHORIZED", "Invalid WebUI host");
    }
    const requestOrigin = req.headers.origin;
    if (requestOrigin !== undefined && requestOrigin !== origin) {
      throw new SupervisorError("UNAUTHORIZED", "Cross-origin requests are not allowed");
    }
    // Browser POSTs must originate in this page; bearer credentials alone do not
    // turn arbitrary websites into an allowed UI client.
    if (req.method === "POST" && requestOrigin !== origin) {
      throw new SupervisorError("UNAUTHORIZED", "A same-origin request is required");
    }
    const url = new URL(req.url ?? "/", origin);
    if (url.origin !== origin) throw new SupervisorError("UNAUTHORIZED", "Invalid request URL");
    this.prune();
    if (url.pathname === "/api/exchange" && req.method === "POST") {
      const body = parse(z.object({
        launchToken: z.string().regex(/^[0-9a-f]{64}$/),
        viewId: z.string().regex(/^[0-9a-f]{32}$/),
      }).strict(), await jsonBody(req));
      const key = digest(body.launchToken);
      const launch = this.launches.get(key);
      if (!launch || launch.viewId !== body.viewId) {
        throw new SupervisorError("UNAUTHORIZED", "Launch link expired or was already used; reopen from HS or DSH");
      }
      this.launches.delete(key);
      const token = secret();
      const credential = { ...launch, expires: Date.now() + SESSION_TTL_MS };
      this.sessions.set(digest(token), credential);
      this.views.set(credential.viewId, credential);
      this.json(res, { token, ownerRef: credential.ownerRef ?? null, preferredOwnerRef: credential.preferredOwnerRef ?? null, expiresAt: new Date(credential.expires).toISOString() });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const authorization = req.headers.authorization;
      const token = authorization?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
      const credential = token ? this.sessions.get(digest(token)) : undefined;
      if (!credential) throw new SupervisorError("UNAUTHORIZED", "WebUI session expired; reopen from HS or DSH");
      await this.api(req, res, url, credential);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      throw new SupervisorError("NOT_FOUND", "Route not found");
    }
    const viewId = url.pathname.match(/^\/view\/([0-9a-f]{32})\/$/)?.[1];
    if (viewId) {
      const view = this.views.get(viewId);
      if (!view) throw new SupervisorError("NOT_FOUND", "This WebUI entry expired; reopen from HS or DSH");
      this.headers(res, view.frameOrigin);
    }
    let file: string;
    let contentType: string;
    if (viewId || url.pathname === "/") {
      file = "index.html";
      contentType = "text/html; charset=utf-8";
    } else if (/^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2?|png|svg)$/.test(url.pathname)) {
      file = url.pathname.slice(1);
      const extension = path.extname(file);
      contentType = ({ ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff": "font/woff", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" } as Record<string, string>)[extension]!;
    } else {
      throw new SupervisorError("NOT_FOUND", "Route not found");
    }
    let data: Buffer;
    try {
      data = await readFile(path.join(this.staticDir(), file));
    } catch {
      throw new SupervisorError("NOT_FOUND", "WebUI asset not found");
    }
    res.setHeader("Content-Type", contentType);
    res.end(req.method === "HEAD" ? undefined : data);
  }

  private async worker(workerId: string, credential: Credential): Promise<WorkerSummary> {
    parse(IdSchema, workerId);
    const record = this.options.supervisor.store.getWorker(workerId);
    if (!record || (credential.ownerRef !== undefined && record.ownerRef !== credential.ownerRef)) {
      // An out-of-scope ID does not disclose whether the worker exists.
      throw new SupervisorError("NOT_FOUND", "Worker not found in this WebUI scope");
    }
    return (await this.options.supervisor.status(workerId, 0)).worker;
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL, credential: Credential): Promise<void> {
    const supervisor = this.options.supervisor;
    if (url.pathname === "/api/session" && req.method === "GET") {
      this.json(res, { version: VERSION, ownerRef: credential.ownerRef ?? null, preferredOwnerRef: credential.preferredOwnerRef ?? null, expiresAt: new Date(credential.expires).toISOString() });
      return;
    }
    if (url.pathname === "/api/workers" && req.method === "GET") {
      const limit = queryInt(url, "limit", 100, 500);
      if (limit < 1) throw new SupervisorError("BAD_REQUEST", "Invalid limit");
      const afterId = url.searchParams.get("afterId");
      const afterCreatedAt = url.searchParams.get("afterCreatedAt");
      if ((afterId === null) !== (afterCreatedAt === null)) throw new SupervisorError("BAD_REQUEST", "Incomplete list cursor");
      const after = afterId !== null && afterCreatedAt !== null ? {
        id: parse(IdSchema, afterId), createdAt: parse(z.string().min(1).max(100), afterCreatedAt),
      } : undefined;
      const workers = supervisor.list({ limit, ownerRef: credential.ownerRef, after });
      const summarize = (records: WorkerSummary[]) => records.map(({ id, name, ownerRef, runtime, status, lifecycle, createdAt, updatedAt, cwd, promptPreview, persistence }) => ({
        id, name, ownerRef, runtime, status, lifecycle, createdAt, updatedAt, cwd, promptPreview, persistence,
      }));
      // Keep the global createdAt cursor intact while making the current
      // conversation visible even when its workers are older than page one.
      const preferred = credential.ownerRef === undefined && credential.preferredOwnerRef !== undefined && after === undefined
        ? supervisor.list({ limit, ownerRef: credential.preferredOwnerRef }) : undefined;
      this.json(res, {
        workers: summarize(workers),
        ...(preferred === undefined ? {} : { preferredWorkers: summarize(preferred) }),
        hasMore: workers.length === limit,
        scope: credential.ownerRef ?? null,
      });
      return;
    }
    const match = url.pathname.match(/^\/api\/workers\/([^/]+)\/(status|events|usage|prompt|answer|cancel)$/);
    if (!match) throw new SupervisorError("NOT_FOUND", "Route not found");
    let workerId: string;
    try {
      workerId = decodeURIComponent(match[1]!);
    } catch {
      throw new SupervisorError("BAD_REQUEST", "Invalid Worker ID");
    }
    const worker = await this.worker(workerId, credential);
    const action = match[2];
    if (action === "prompt" && req.method === "GET") {
      this.json(res, await supervisor.store.readPrompt(workerId));
    } else if (action === "status" && req.method === "GET") {
      this.json(res, await supervisor.status(workerId, 0));
    } else if (action === "events" && req.method === "GET") {
      const limit = queryInt(url, "limit", 100, 500);
      if (limit < 1) throw new SupervisorError("BAD_REQUEST", "Invalid limit");
      this.json(res, await supervisor.events(workerId, { sinceSeq: queryInt(url, "sinceSeq", 0, Number.MAX_SAFE_INTEGER), limit }));
    } else if (action === "usage" && req.method === "GET") {
      // A task may contain workers from several Masters. Return this worker's
      // own records only, without task titles, other worker IDs or parent usage.
      try {
        const usage = worker.taskId ? supervisor.metricsTask(worker.taskId).usage.filter((record) => record.workerId === workerId && record.role === "worker") : [];
        this.json(res, { available: true, usage });
      } catch (error) {
        if (!(error instanceof SupervisorError) || error.code !== "UNSUPPORTED") throw error;
        this.json(res, { available: false, usage: [] });
      }
    } else if (action === "answer" && req.method === "POST") {
      const body = parse(AnswerSchema, await jsonBody(req));
      // Revalidate scope after reading an asynchronously delivered body.
      await this.worker(workerId, credential);
      this.json(res, await supervisor.answer(workerId, body.requestId, body.response));
    } else if (action === "cancel" && req.method === "POST") {
      parse(z.object({}).strict(), await jsonBody(req));
      await this.worker(workerId, credential);
      this.json(res, await supervisor.cancel(workerId));
    } else {
      throw new SupervisorError("NOT_FOUND", "Route not found");
    }
  }

  private json(res: ServerResponse, value: unknown): void {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(value));
  }

  private fail(res: ServerResponse, error: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    const serialized = serializeError(error);
    res.statusCode = ({ UNAUTHORIZED: 401, NOT_FOUND: 404, BAD_REQUEST: 400, LIMIT_EXCEEDED: 429, INVALID_STATE: 409, CONFLICT: 409 } as Record<string, number>)[serialized.code] ?? 500;
    this.json(res, { error: { code: serialized.code, message: serialized.code === "INTERNAL" ? "WebUI request failed" : serialized.message } });
  }
}
