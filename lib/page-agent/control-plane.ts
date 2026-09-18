/**
 * The control plane the browser talks to during a real run.
 *
 * Nothing here re-implements an endpoint. Every `/api/**` request is dispatched
 * to the same `app/api/**\/route.ts` handler the production server runs, in
 * this process, with the stores in their memory mode (no `DATABASE_URL`, no
 * bucket). So the AgentRun ledger, the model proxy, the evidence store and the
 * Episode ingestion path — including the authority gate that runs inside it —
 * are the production code, and the only thing standing in for the database is
 * the store's own in-memory branch.
 *
 * The one thing seeded from outside is the site agent and its Release, because
 * that Release *is* module input ②: it comes from the input file rather than
 * from a site the colleague has to onboard first.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import type {
  PageAgentObservation,
  SceneDefinition,
  SiteAgentReleaseV2,
  SiteProfile,
  TaskEpisode,
} from "../site-knowledge/protocol";
import { stableHash } from "../site-knowledge/protocol";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const apiRoot = resolve(root, "app/api");
const publicRoot = resolve(root, "public");
const SDK_ASSETS = new Set(["/sitewake.js", "/sitewake-adaptive.js"]);

export type ControlPlaneCapture = {
  /** Exactly what the module POSTed, before the server did anything with it. */
  episodes: TaskEpisode[];
  observations: PageAgentObservation[];
  runIds: string[];
  modelCalls: Array<{ stage: string; status: number; durationMs: number }>;
  failures: Array<{ method: string; path: string; status: number; detail: string }>;
  /**
   * Every keyword search the module ran against the content index, and how many
   * pages each one hit. A zero-hit search is the signal that the passages in
   * the input did not cover the words the model actually chose — the one way
   * this input shape can quietly under-serve a run.
   */
  knowledgeSearches: Array<{ keywords: string[]; hits: number }>;
};

type RouteMatch = { file: string; params: Record<string, string> };

const routeCache = new Map<string, RouteMatch | null>();

/** Resolve a pathname the way the file-system router does: literal first, then `[param]`. */
async function resolveRoute(segments: string[]): Promise<RouteMatch | null> {
  const key = segments.join("/");
  const cached = routeCache.get(key);
  if (cached !== undefined) return cached;
  let dir = apiRoot;
  const params: Record<string, string> = {};
  for (const segment of segments) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const literal = entries.find((entry) => entry.isDirectory() && entry.name === segment);
    if (literal) { dir = resolve(dir, literal.name); continue; }
    const dynamic = entries.find((entry) => entry.isDirectory() && /^\[[^.\]]+]$/.test(entry.name));
    if (!dynamic) { routeCache.set(key, null); return null; }
    params[dynamic.name.slice(1, -1)] = decodeURIComponent(segment);
    dir = resolve(dir, dynamic.name);
  }
  const match: RouteMatch = { file: resolve(dir, "route.ts"), params };
  routeCache.set(key, match);
  return match;
}

function readBody(request: IncomingMessage) {
  return new Promise<Buffer>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function headersOf(request: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/**
 * What the control plane needs seeded before a module can run against it. Both
 * browser-side units describe the same site in their own input file, so the
 * seed is stated once here rather than being read out of either contract.
 */
export type ControlPlaneSeed = {
  siteAgentId: string;
  /** The page the run starts on, and the origin it is confined to. */
  url: string;
  origin: string;
  visibility?: "production" | "sandbox" | "system";
  runtimeFeatures?: SiteAgentReleaseV2["runtimeFeatures"];
  release: {
    id?: string;
    profile: Pick<SiteProfile, "name" | "description" | "suggestedGoals" | "taskTemplates" | "vocabulary" | "jobsToBeDone">;
    scenes: Array<Pick<SceneDefinition, "id" | "name" | "description" | "businessArea" | "urlTemplates">>;
  };
  /** Page passages to index. Empty when the unit does not retrieve knowledge. */
  content?: Array<{ url: string; sceneId?: string; heading?: string; text: string }>;
};

/**
 * The runtime Release is the site-knowledge module's output, so a real run
 * receives it rather than deriving it. Only the structural fields a Release
 * must carry to be executable are filled in from the store's own empty one.
 */
export function releaseFromModuleInput(base: SiteAgentReleaseV2, input: ControlPlaneSeed): SiteAgentReleaseV2 {
  const createdAt = new Date().toISOString();
  const release = {
    ...base,
    id: input.release.id || `${base.siteAgentId}:release:${base.version + 1}`,
    version: base.version + 1,
    createdAt,
    profile: {
      ...base.profile,
      ...input.release.profile,
      // Execution authority stays with the control plane: the input describes
      // the site, it does not get to widen where the runtime may act.
      entryUrl: input.url,
      allowedOrigins: [...new Set([...(base.profile.allowedOrigins || []), input.origin])],
    },
    scenes: input.release.scenes.map((scene) => ({
      ...scene,
      evidenceStatus: "observed" as const,
      directEntry: "verified" as const,
      parameters: [],
      verifier: {},
      sourceObservationIds: [],
      updatedAt: createdAt,
    })),
    linkReferences: [],
  };
  // The Release's own hash covers the whole aggregate; the input declares only
  // the knowledge half, so this is computed here rather than taken from it.
  const hashable = { ...release, contentHash: undefined, knowledgeRevision: undefined };
  return { ...release, contentHash: stableHash(JSON.stringify(hashable)) };
}

export type ModuleControlPlane = {
  origin: string;
  siteAgentId: string;
  release: SiteAgentReleaseV2;
  /** How many of the input's pages made it into the content index. */
  indexedPages: number;
  capture: ControlPlaneCapture;
  close: () => Promise<void>;
};

export async function startModuleControlPlane(
  input: ControlPlaneSeed,
  options: { port?: number } = {},
): Promise<ModuleControlPlane> {
  // Memory mode is the only difference from production. A real database or
  // bucket reachable through the developer's env would make this command write
  // to shared state, which a unit test must never do.
  delete process.env.DATABASE_URL;
  delete process.env.S3_BUCKET;
  // Runtime features are server-injected: the public Release endpoint recomputes
  // them from these rollout flags and overwrites whatever the stored Release
  // carried. So the features the input declares only take effect if they are
  // turned into the flags that endpoint reads — otherwise an input asking for
  // evidence V2 would silently run on the V1 evidence path, and the downstream
  // authority could never pass no matter how the task went.
  const features = input.runtimeFeatures || { pageAgentRuntimeV2: true, pageAgentEvidenceV2: true, capabilityExperienceOutbox: true };
  process.env.SITEWAKE_PAGE_AGENT_RUNTIME_V2 = features.pageAgentRuntimeV2 ? "all" : "off";
  process.env.SITEWAKE_PAGE_AGENT_EVIDENCE_V2 = features.pageAgentEvidenceV2 ? "all" : "off";
  process.env.SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX = features.capabilityExperienceOutbox ? "all" : "off";

  // Fail closed rather than trusting import order: db/index.ts wires its adapter
  // at module load, so a store imported before those deletes would already hold a
  // live production connection and every write below would land in it.
  const { getD1Binding, getArtifactBinding } = await import("../../db/index");
  if (getD1Binding() || getArtifactBinding()) {
    throw new Error("拒绝运行：进程里已经接上了真实数据库或对象存储。这个单元只能跑在内存存储上，绝不写生产数据。");
  }

  const siteAgentId = input.siteAgentId;
  const [{ activatePreparedSiteAgentReleaseInMemory, createSiteAgent, getActiveSiteAgentRelease, ingestSiteContentPages }] = await Promise.all([
    import("../../db/site-agent-store"),
  ]);
  await createSiteAgent({
    id: siteAgentId,
    name: siteAgentId,
    url: input.url,
    visibility: input.visibility === "sandbox" ? "sandbox" : "production",
  });
  const current = await getActiveSiteAgentRelease(siteAgentId);
  const release = activatePreparedSiteAgentReleaseInMemory(
    siteAgentId,
    current.release.id,
    releaseFromModuleInput(current.release, input),
  );

  // The passages are indexed so the module can retrieve them the way it does in
  // production — it still issues a real keyword search; this is only what that
  // search has to find. Passages sharing a URL are one page, in input order.
  const passagesByUrl = new Map<string, { sceneId?: string; heading?: string; parts: string[] }>();
  for (const match of input.content || []) {
    const page = passagesByUrl.get(match.url) || { sceneId: match.sceneId, heading: match.heading, parts: [] };
    page.parts.push(match.text);
    passagesByUrl.set(match.url, page);
  }
  const content = await ingestSiteContentPages(siteAgentId, [...passagesByUrl].map(([url, page]) => ({
    url,
    sceneId: page.sceneId,
    heading: page.heading,
    visibleText: page.parts.join("\n\n"),
  })));

  const capture: ControlPlaneCapture = { episodes: [], observations: [], runIds: [], modelCalls: [], failures: [], knowledgeSearches: [] };
  const assets = new Map<string, string>();

  const server = createServer((request, response) => {
    void dispatch(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "application/json", "access-control-allow-origin": "*" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  async function dispatch(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url || "/", `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    if (SDK_ASSETS.has(url.pathname)) {
      let body = assets.get(url.pathname);
      if (body === undefined) {
        body = await readFile(resolve(publicRoot, url.pathname.slice(1)), "utf8");
        assets.set(url.pathname, body);
      }
      response.writeHead(200, {
        "content-type": "application/javascript",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      return response.end(body);
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "api") {
      response.writeHead(404, { "content-type": "application/json", "access-control-allow-origin": "*" });
      return response.end(JSON.stringify({ error: "not_found" }));
    }
    const match = await resolveRoute(segments.slice(1));
    const route = match ? await import(match.file).catch(() => undefined) : undefined;
    const method = (request.method || "GET").toUpperCase();
    const handler = route?.[method] as undefined | ((request: NextRequest, context: { params: Record<string, string> }) => Promise<Response>);
    if (!match || !handler) {
      capture.failures.push({ method, path: url.pathname, status: 404, detail: "no_production_route" });
      response.writeHead(404, { "content-type": "application/json", "access-control-allow-origin": "*" });
      return response.end(JSON.stringify({ error: `no_production_route:${method}:${url.pathname}` }));
    }
    const raw = method === "GET" || method === "HEAD" || method === "OPTIONS" ? undefined : await readBody(request);
    const started = Date.now();
    const result = await handler(
      new NextRequest(url, { method, headers: headersOf(request), body: raw?.length ? new Uint8Array(raw) : undefined }),
      { params: match.params },
    );
    const text = await result.text();
    record(method, url, request, raw, result.status, text, Date.now() - started);
    const headers: Record<string, string> = {};
    result.headers.forEach((value, name) => { headers[name] = value; });
    response.writeHead(result.status, headers);
    return response.end(text);
  }

  function record(
    method: string,
    url: URL,
    request: IncomingMessage,
    raw: Buffer | undefined,
    status: number,
    text: string,
    durationMs: number,
  ) {
    const path = url.pathname;
    let body: Record<string, unknown> | undefined;
    if (raw?.length) { try { body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; } catch { /* not JSON */ } }
    if (status >= 400) capture.failures.push({ method, path, status, detail: text.slice(0, 400) });
    if (path === "/api/agent-runs" && method === "POST" && status < 400) {
      const created = JSON.parse(text) as { run?: { id?: string } };
      if (created.run?.id) capture.runIds.push(created.run.id);
    }
    if (path.endsWith("/episodes") && method === "POST" && body) capture.episodes.push(body as unknown as TaskEpisode);
    if (path.endsWith("/page-observations") && method === "POST" && Array.isArray(body?.observations)) {
      capture.observations.push(...(body.observations as PageAgentObservation[]));
    }
    if (path.endsWith("/chat/completions") && method === "POST") {
      capture.modelCalls.push({
        stage: String(request.headers["x-sitewake-ai-stage"] || "runtime-agent"),
        status,
        durationMs,
      });
    }
    if (path.endsWith("/content") && method === "GET") {
      const keywords = url.searchParams.getAll("keyword");
      // `?url=` is read_page fetching one page in full, not a keyword search.
      if (keywords.length) {
        let hits = 0;
        try { hits = Number((JSON.parse(text) as { totalPagesWithHits?: number }).totalPagesWithHits || 0); } catch { /* non-JSON */ }
        capture.knowledgeSearches.push({ keywords, hits });
      }
    }
  }

  await new Promise<void>((ready) => server.listen(options.port || 0, "127.0.0.1", ready));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    siteAgentId,
    release,
    indexedPages: content.indexed,
    capture,
    close: () => new Promise<void>((closed, failed) => server.close((error) => error ? failed(error) : closed())),
  };
}
