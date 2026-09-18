import {
  stableHash,
  type JsonPrimitive,
  type PageSnapshot,
  type SceneDefinition,
  type SceneInstance,
  type UrlTemplate,
} from "./protocol";

const TRACKING_KEYS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "spm", "from", "ref"]);

// Error / soft-404 pages must never become knowledge: their title poisons scene names
// ("页面未找到") and their nav seeds junk routes. Matched on the visible title/heading.
const ERROR_TITLE = /页面(?:未|没)?(?:找到|不存在|已删除|已失效|出错)|找不到该?页|无法访问|访问出错|\b404\b|not\s*found|page\s*not\s*found/i;
export function isErrorTitle(text?: string): boolean {
  return typeof text === "string" && ERROR_TITLE.test(text);
}
/**
 * Decides "this page is not knowledge". **HTTP status first**: independent of language
 * and site wording, the only general signal. The title word list is a fallback only —
 * production tripped on "页面没找到", one character off from the list's "页面未找到",
 * and that link target became a scene named "页面没找到".
 */
export function isErrorPage(page: Pick<PageSnapshot, "title" | "heading"> & { httpStatus?: number }): boolean {
  if (typeof page.httpStatus === "number" && page.httpStatus >= 400) return true;
  return isErrorTitle(page.title) || isErrorTitle(page.heading);
}

/**
 * The site identity an origin belongs to, with the SCHEME dropped for http/https.
 *
 * http:// and https:// on one host are one site. A site that serves plaintext without
 * redirecting (a real production site did) otherwise grows a second, parallel copy of its whole
 * map: Scene ids and canonicalize's group key both carried the scheme, so the twin never
 * merged, and `matchUrlTemplate` rejected the other scheme, so an https entry probe could
 * never promote it past `referenced` — the console filled with "link candidate · awaiting
 * real visit" areas for pages that had in fact been crawled and verified.
 *
 * IDENTITY only. The stored `originPattern` keeps a real, fetchable origin so
 * `buildSceneUrl` still works (including http-only localhost/dev origins), and the
 * security boundaries that gate fetching and execution (crawl provenance,
 * `allowedOrigins`, pinned fetches) keep comparing full origins.
 */
export function siteIdentityOrigin(originPattern: string): string {
  if (originPattern.includes("*")) return originPattern;
  try {
    const url = new URL(originPattern);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : originPattern;
  } catch {
    return originPattern;
  }
}

// A path segment that identifies one INSTANCE of a family (a name, date or id), so the
// whole family collapses onto ONE parameterised route — /celebrity/李宏毅, /daily/2026-07-27
// and /topic/WnBzdg become /celebrity/{path1} etc., instead of a scene per value. This
// governs BOTH scene identity and the crawl frontier (one representative rendered per
// family), so it fixes the "crawled piles of near-identical pages" bloat at the root. All-lowercase words
// (about, search, celebrity) stay LITERAL — those are distinct pages, not instances.
function dynamicSegment(segment: string) {
  let value = segment;
  try { value = decodeURIComponent(segment); } catch { /* percent-decode failed — match the raw form */ }
  return /^\d{3,}$/.test(segment)                       // numeric id
    || /^[0-9a-f]{8,}$/i.test(segment)                  // hex hash
    || /^[a-z0-9_-]{18,}$/i.test(segment)               // long slug
    || /[㐀-鿿]/.test(value)                    // CJK — a person/place name, never a page path
    || /^\d{4}-\d{2}(?:-\d{2})?$/.test(value)           // date (YYYY-MM or YYYY-MM-DD)
    || (/^[A-Za-z0-9_-]{5,}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value)); // mixed-case id / latin name (WnBzdg, Angelababy) — not an all-lowercase page word
}

/** The path a route-hash (`#/route`, `#!/route`) points at, else "" for a plain anchor. */
function hashRoutePath(hash: string): string {
  return /^#!?\//.test(hash) ? hash.replace(/^#!?/, "").replace(/\?.*$/, "") : "";
}

/** The effective route path a URL resolves to, folding a hash route onto the base path. */
export function effectiveRoutePath(url: URL): { effectivePath: string; route: string; basePath: string } {
  const route = hashRoutePath(url.hash);
  const basePath = url.pathname.replace(/\/+$/, "");
  return { effectivePath: route ? `${basePath}${route}` : url.pathname, route, basePath };
}

function parameterizePath(path: string): string {
  let parameterIndex = 0;
  return path
    .split("/")
    .map((segment) => {
      if (!dynamicSegment(segment)) return segment;
      parameterIndex += 1;
      return `{path${parameterIndex}}`;
    })
    .join("/");
}

export function urlTemplateFromUrl(rawUrl: string): UrlTemplate {
  const url = new URL(rawUrl, "http://localhost");
  // Hash-router SPAs (#/route) carry the real page in the fragment. Fold that
  // route into the effective path so /#/orders and /#/clients are distinct
  // Scenes instead of collapsing onto one "/". A plain #anchor stays a param.
  const { effectivePath, route } = effectiveRoutePath(url);
  const pathnamePattern = parameterizePath(effectivePath);
  const query: Record<string, string> = {};
  const ignoredQueryKeys: string[] = [];
  for (const [key, value] of url.searchParams) {
    if (TRACKING_KEYS.has(key) || key.startsWith("utm_")) {
      ignoredQueryKeys.push(key);
      continue;
    }
    query[key] = value ? `{${key}}` : "";
  }
  const signature = `${url.origin}${pathnamePattern}?${Object.keys(query).sort().join("&")}#${route ? "route" : url.hash ? "{hash}" : ""}`;
  return {
    id: `url_${stableHash(signature)}`,
    originPattern: url.origin,
    pathnamePattern,
    query,
    hashPattern: route ? undefined : url.hash ? "{hash}" : undefined,
    ignoredQueryKeys,
    ...(route ? { routeMode: "hash" as const, basePath: url.pathname || "/" } : {}),
  };
}

function matchPath(pattern: string, pathname: string) {
  const decode = (segment: string) => { try { return decodeURIComponent(segment); } catch { return segment; } };
  const expected = pattern.replace(/^\/+|\/+$/g, "").split("/").map(decode);
  const actual = pathname.replace(/^\/+|\/+$/g, "").split("/").map(decode);
  if (expected.length !== actual.length) return null;
  const bindings: Record<string, JsonPrimitive> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const parameter = expected[index].match(/^\{([^}]+)\}$/)?.[1]?.replace(/\?$/, "");
    if (parameter) bindings[parameter] = actual[index];
    else if (expected[index] !== actual[index]) return null;
  }
  return bindings;
}

export function matchUrlTemplate(template: UrlTemplate, rawUrl: string) {
  const url = new URL(rawUrl, template.originPattern);
  // Same host over the other scheme is the same page — see siteIdentityOrigin. Host, port
  // and everything below stay exact.
  if (template.originPattern !== "*"
    && siteIdentityOrigin(url.origin) !== siteIdentityOrigin(template.originPattern)) return null;
  // A route-hash URL (#/route) is a distinct page: only a hash-mode template may
  // match it, and a hash-mode template only matches route-hash URLs — otherwise
  // /#/orders would collapse onto the base "/" template again.
  const route = hashRoutePath(url.hash);
  if (Boolean(route) !== (template.routeMode === "hash")) return null;
  const target = template.routeMode === "hash" ? effectiveRoutePath(url).effectivePath : url.pathname;
  const bindings = matchPath(template.pathnamePattern, target);
  if (!bindings) return null;
  for (const [key, pattern] of Object.entries(template.query)) {
    const optional = pattern.endsWith("?}");
    const value = url.searchParams.get(key);
    if (value === null && !optional) return null;
    const name = pattern.match(/^\{(.+?)\??\}$/)?.[1];
    if (name && value !== null) bindings[name] = value;
    else if (value !== pattern && !optional) return null;
  }
  if (template.hashPattern && url.hash) {
    const name = template.hashPattern.match(/^\{(.+?)\}$/)?.[1];
    if (name) bindings[name] = url.hash.slice(1);
  }
  return bindings;
}

export type UrlFamily = { template: string; name?: string; members?: string[] };

function familyTemplateFromPattern(origin: string, pattern: string): UrlTemplate {
  const pathnamePattern = pattern.startsWith("/") ? pattern : `/${pattern}`;
  return { id: `url_${stableHash(`${origin}${pathnamePattern}`)}`, originPattern: origin, pathnamePattern, query: {} };
}

/**
 * Fold literal scenes into AI-proposed family templates (the general layer beyond the
 * name/date/id heuristic — it catches lowercase slugs the patterns can't). Each proposed
 * template is VALIDATED before use: it must be parameterized, have a LITERAL first segment
 * (never a top-level /{x} that would swallow distinct pages like /about + /pricing), and
 * actually `matchUrlTemplate` ≥2 of the crawl's literal scenes. A matching literal scene is
 * relabeled to the family template with its value as an example; canonicalize then merges
 * the now-identical patterns. A bad AI answer can only be IGNORED here — never corrupt
 * knowledge — because nothing is applied unless it validates.
 */
export function relabelScenesByFamilies(scenes: SceneDefinition[], origin: string, families: UrlFamily[]): SceneDefinition[] {
  const literalPath = (scene: SceneDefinition) => {
    const path = scene.urlTemplates[0]?.pathnamePattern;
    return path && !path.includes("{") ? path : undefined;
  };
  const templatePattern = (scene: SceneDefinition) => {
    const path = scene.urlTemplates[0]?.pathnamePattern;
    return path && path.includes("{") ? path : undefined;
  };
  // Same route shape regardless of parameter NAME: literal segments equal, {param} aligns
  // with {param} — so the AI's /celebrity/{name} names an existing /celebrity/{path1}.
  const sameStructure = (a: string, b: string) => {
    const sa = a.split("/").filter(Boolean); const sb = b.split("/").filter(Boolean);
    if (sa.length !== sb.length) return false;
    return sa.every((segment, index) => {
      const pa = /^\{[^}]+\}$/.test(segment); const pb = /^\{[^}]+\}$/.test(sb[index]);
      return pa && pb ? true : !pa && !pb && segment === sb[index];
    });
  };
  const validated = families
    .map((family) => ({ family, pattern: family.template.startsWith("/") ? family.template : `/${family.template}`, template: familyTemplateFromPattern(origin, family.template) }))
    .filter(({ pattern, template }) => {
      const segments = pattern.split("/").filter(Boolean);
      const firstLiteral = Boolean(segments[0]) && !/^\{[^}]+\}$/.test(segments[0]);
      const parameterized = /\{[^}]+\}/.test(pattern);
      if (!firstLiteral || !parameterized) return false;
      // Valid if it either folds >=2 literal scenes, or names an existing template of the
      // same shape (the heuristic already collapsed that family — AI just names it).
      const foldsLiterals = scenes.filter((scene) => { const path = literalPath(scene); return path && matchUrlTemplate(template, `${origin}${path}`); }).length >= 2;
      const namesTemplate = scenes.some((scene) => { const path = templatePattern(scene); return path && sameStructure(path, pattern); });
      return foldsLiterals || namesTemplate;
    });
  if (!validated.length) return scenes;
  return scenes.map((scene) => {
    const literal = literalPath(scene);
    if (literal) {
      const hit = validated.find(({ template }) => matchUrlTemplate(template, `${origin}${literal}`));
      if (!hit) return scene;
      const bindings = matchUrlTemplate(hit.template, `${origin}${literal}`) || {};
      const parameters = Object.entries(bindings).map(([id, value]) => ({ id, name: id, type: "string" as const, required: true, examples: [String(value)] }));
      // A generic family name from the AI is a real semantic understanding — carry it and
      // mark the scene AI-classified so the whole family shows one generic name ("country/region
      // trends"), not one instance ("Indonesia trending events"). All members share it, so canonicalize keeps it.
      const named = hit.family.name ? { name: hit.family.name, semanticSource: "ai" as const } : {};
      return { ...scene, ...named, urlTemplates: [hit.template], parameters };
    }
    const template = templatePattern(scene);
    if (template) {
      // Existing (heuristic-collapsed) template — just apply the generic AI name.
      const hit = validated.find(({ pattern }) => sameStructure(template, pattern));
      if (hit?.family.name) return { ...scene, name: hit.family.name, semanticSource: "ai" as const };
    }
    return scene;
  });
}

export function buildSceneUrl(scene: SceneDefinition, bindings: Record<string, JsonPrimitive>, runtimeOrigin?: string) {
  const template = scene.urlTemplates[0];
  if (!template) throw new Error(`scene_has_no_url_template:${scene.id}`);
  const pathname = template.pathnamePattern.replace(/\{([^}]+)\}/g, (_, rawKey: string) => {
    const optional = rawKey.endsWith("?");
    const key = rawKey.replace(/\?$/, "");
    const value = bindings[key];
    if (value === undefined || value === null || value === "") {
      if (optional) return "";
      throw new Error(`scene_binding_missing:${key}`);
    }
    // Path bindings must remain a single segment. Query bindings below are
    // deliberately passed raw to URLSearchParams, which performs exactly one
    // encoding pass.
    return encodeURIComponent(String(value));
  });
  // Scene knowledge identifies routes within one Site Agent. At runtime the
  // same site may be reached through localhost, a LAN address, or another
  // approved host alias. Prefer the live page Origin so a route learned on one
  // alias never becomes a cross-Origin handoff on another. Callers that are
  // compiling or inspecting knowledge omit runtimeOrigin and retain the
  // evidence Origin exactly.
  const origin = runtimeOrigin || (template.originPattern.includes("*") ? undefined : template.originPattern);
  if (!origin) throw new Error(`scene_origin_missing:${scene.id}`);
  // Hash-router SPAs: `pathname` is the effective route — put it back in the
  // fragment, hung off the real base path (usually "/").
  const base = template.routeMode === "hash" ? (template.basePath || "/") : pathname;
  const url = new URL(base, origin);
  if (template.routeMode === "hash") {
    const baseNoSlash = (template.basePath || "").replace(/\/+$/, "");
    url.hash = baseNoSlash && pathname.startsWith(baseNoSlash) ? pathname.slice(baseNoSlash.length) || "/" : pathname;
  }
  for (const [key, pattern] of Object.entries(template.query)) {
    const name = pattern.match(/^\{(.+?)\??\}$/)?.[1];
    if (name && bindings[name] !== undefined) url.searchParams.set(key, String(bindings[name]));
    else if (!name && pattern) url.searchParams.set(key, pattern);
  }
  if (template.routeMode !== "hash" && template.hashPattern) {
    const name = template.hashPattern.match(/^\{(.+?)\}$/)?.[1];
    if (name && bindings[name] !== undefined) url.hash = String(bindings[name]);
  }
  return url.toString();
}

export function recognizeScene(scenes: SceneDefinition[], snapshot: Pick<PageSnapshot, "url" | "title" | "heading" | "visibleText">): SceneInstance | undefined {
  const candidates = scenes.flatMap((scene) => scene.urlTemplates.map((template) => ({ scene, bindings: matchUrlTemplate(template, snapshot.url) })))
    .filter((item): item is { scene: SceneDefinition; bindings: Record<string, JsonPrimitive> } => Boolean(item.bindings));
  for (const { scene, bindings } of candidates) {
    const verifier = scene.verifier;
    if (verifier.titleIncludes?.length && !verifier.titleIncludes.some((item) => snapshot.title.includes(item))) continue;
    if (verifier.headingIncludes?.length && !verifier.headingIncludes.some((item) => snapshot.heading.includes(item))) continue;
    if (verifier.textIncludes?.length && !verifier.textIncludes.every((item) => snapshot.visibleText.includes(item))) continue;
    return { sceneId: scene.id, url: snapshot.url, bindings, confidence: 0.96, observedAt: new Date().toISOString() };
  }
  return undefined;
}

export function sceneFromSnapshot(snapshot: PageSnapshot, name?: string): SceneDefinition {
  const rawTemplate = urlTemplateFromUrl(snapshot.url);
  const template = { ...rawTemplate, query: Object.fromEntries(Object.entries(rawTemplate.query).map(([key, value]) => [key, value.match(/^\{(.+)\}$/) ? `{${key}?}` : value])) };
  const observedBindings = matchUrlTemplate(template, snapshot.url) || {};
  const parameters = [...template.pathnamePattern.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
    .concat(Object.values(template.query).flatMap((value) => value.match(/^\{(.+?)\??\}$/)?.[1] || []));
  const id = `scene_${stableHash(`${siteIdentityOrigin(template.originPattern)}:${template.pathnamePattern}`)}`;
  return {
    id,
    name: name || (isErrorTitle(snapshot.heading) ? undefined : snapshot.heading) || (isErrorTitle(snapshot.title) ? undefined : snapshot.title) || new URL(snapshot.url).pathname,
    semanticSource: "program",
    evidenceStatus: "observed",
    lifecycle: "observed",
    identityConfidence: 0.82,
    evidence: {
      linkLabels: [],
      observedUrls: [snapshot.url],
      titles: snapshot.title ? [snapshot.title] : [],
      headings: snapshot.heading ? [snapshot.heading] : [],
    },
    urlTemplates: [template],
    parameters: [...new Set(parameters)].map((parameter) => ({
      id: parameter,
      name: parameter,
      type: "string" as const,
      required: !Object.values(template.query).some((value) => value.includes(`{${parameter}`)),
      examples: observedBindings[parameter] === undefined ? [] : [observedBindings[parameter]],
    })),
    verifier: {
      headingIncludes: snapshot.heading ? [snapshot.heading.slice(0, 80)] : undefined,
    },
    directEntry: "candidate",
    sourceObservationIds: [snapshot.id],
    createdAt: snapshot.capturedAt,
    updatedAt: snapshot.capturedAt,
  };
}
