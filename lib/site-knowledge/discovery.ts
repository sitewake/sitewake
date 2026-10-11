import {
  mergeOrigins,
  stableHash,
  strongerEvidenceStatus,
  type ElementEvidence,
  type LinkReference,
  type OperationDefinition,
  type PageSnapshot,
  type SceneDefinition,
  type SiteAgentReleaseV2,
  type TargetSpec,
  type TransitionObservation,
  type UrlTemplate,
} from "./protocol";
import { isErrorTitle, matchUrlTemplate, recognizeScene, sceneFromSnapshot, siteIdentityOrigin, urlTemplateFromUrl } from "./url-scene";

function unique(values: string[], limit = 30) {
  return [...new Set(values.filter(Boolean))].slice(-limit);
}

export function mergeSceneEvidence(previous: SceneDefinition, incoming: SceneDefinition): SceneDefinition {
  const previousEvidence = previous.evidence || { linkLabels: [], observedUrls: [], titles: [], headings: [] };
  const incomingEvidence = incoming.evidence || { linkLabels: [], observedUrls: [], titles: [], headings: [] };
  const evidenceStatus = strongerEvidenceStatus(
    strongerEvidenceStatus(previous.evidenceStatus, previous.lifecycle),
    strongerEvidenceStatus(incoming.evidenceStatus, incoming.lifecycle),
  );
  const reviewed = previous.semanticSource === "human" || incoming.semanticSource === "human"
    ? "human"
    : previous.semanticSource === "ai" || incoming.semanticSource === "ai" ? "ai" : "program";
  // Provenance precedence: human > fresh AI review > usage-ai > crawl. A crawl-origin
  // scene freely contributes structural evidence (URLs, links, parameters) below, but
  // must not overwrite a name/description already refined by usage or a human.
  const incomingIsCrawl = incoming.origin === "crawl";
  const previousSemanticsLocked = previous.semanticSource === "ai" || previous.semanticSource === "human" || Boolean(previous.description);
  // A COMPLETED semantic review (reviewSceneSemantics stamps semanticReview.reviewedAt)
  // is the authoritative namer: it may refresh a prior AI/program name even on a
  // crawl-origin scene — the crawl guard only blocks structural re-observation, not a
  // genuine re-review. Human names still win; a stale review never beats a newer one.
  const incomingIsFreshReview = incoming.semanticReview?.status === "reviewed"
    && (incoming.semanticReview.reviewedAt || "") >= (previous.semanticReview?.reviewedAt || "");
  const incomingWins = incoming.semanticSource === "ai" || incoming.semanticSource === "human"
    || (!previous.description && (incoming.evidenceStatus === "observed" || incoming.evidenceStatus === "crawled" || incoming.lifecycle === "observed"));
  const preferred = incomingWins
    && (incomingIsFreshReview ? previous.semanticSource !== "human" : !(incomingIsCrawl && previousSemanticsLocked))
    ? incoming : previous;
  const origins = mergeOrigins(previous.origins, previous.origin, incoming.origins, incoming.origin);
  const parameters = new Map(previous.parameters.map((parameter) => [parameter.id, parameter]));
  for (const parameter of incoming.parameters) {
    const current = parameters.get(parameter.id);
    parameters.set(parameter.id, current ? { ...current, ...parameter, name: parameter.name === parameter.id ? current.name : parameter.name, required: current.required && parameter.required, examples: [...new Set([...current.examples, ...parameter.examples])].slice(0, 16) } : parameter);
  }
  // Direct-entry readiness is authored only by the entry verifier, which stamps
  // lastVerifiedAt / demotedAt. Keep whichever side made the more recent entry
  // decision so a DEMOTION is never silently re-promoted by a stale verified copy;
  // a plain re-observation (no stamp) never overrides the stored entry state.
  const entryStamp = (candidate: SceneDefinition) => Math.max(Date.parse(candidate.lastVerifiedAt || "") || 0, Date.parse(candidate.demotedAt || "") || 0);
  const entrySource = entryStamp(incoming) > entryStamp(previous) ? incoming : previous;
  // The `entry-verified` rung follows the entry authority, so a stale entry-verified
  // copy can't hold the top rung once the current decision is not verified.
  const resolvedEvidenceStatus = evidenceStatus === "entry-verified" && entrySource.directEntry !== "verified" ? "observed" : evidenceStatus;
  return {
    ...previous,
    name: preferred.name || previous.name,
    description: preferred.description || previous.description,
    semanticSource: reviewed,
    businessArea: incoming.businessArea || previous.businessArea,
    evidenceStatus: resolvedEvidenceStatus,
    origin: origins?.includes("usage") ? "usage" : origins?.[0] || previous.origin,
    origins,
    semanticReview: incoming.semanticReview || previous.semanticReview,
    lifecycle: resolvedEvidenceStatus,
    identityConfidence: Math.max(previous.identityConfidence || 0, incoming.identityConfidence || 0),
    evidence: {
      linkLabels: unique([...previousEvidence.linkLabels, ...incomingEvidence.linkLabels]),
      observedUrls: unique([...previousEvidence.observedUrls, ...incomingEvidence.observedUrls]),
      titles: unique([...previousEvidence.titles, ...incomingEvidence.titles]),
      headings: unique([...previousEvidence.headings, ...incomingEvidence.headings]),
    },
    parameters: [...parameters.values()],
    urlTemplates: previous.urlTemplates.map((template, index) => index ? template : { ...template, query: { ...template.query, ...(incoming.urlTemplates[0]?.query || {}) } }),
    directEntry: entrySource.directEntry,
    lastVerifiedAt: entrySource.lastVerifiedAt,
    demotedAt: entrySource.demotedAt,
    verificationFailure: entrySource.verificationFailure,
    entryHealth: entrySource.entryHealth,
    verifier: incoming.evidenceStatus === "observed" || incoming.lifecycle === "observed" ? { ...previous.verifier, ...incoming.verifier } : previous.verifier,
    sourceObservationIds: unique([...previous.sourceObservationIds, ...incoming.sourceObservationIds], 100),
    // The first appearance time follows the earliest copy: re-observation is not rebirth.
    createdAt: previous.createdAt || incoming.createdAt,
    updatedAt: incoming.updatedAt > previous.updatedAt ? incoming.updatedAt : previous.updatedAt,
  };
}

function segments(url: URL) {
  return url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
}

function entityLikeSegment(segment: string) {
  return /^\d{3,}$/.test(segment) || /^[0-9a-f]{8,}$/i.test(segment) || /^[a-z0-9_-]{18,}$/i.test(segment);
}

function hasTrustedDynamicPath(group: Array<{ segments: string[] }>) {
  const width = group[0]?.segments.length || 0;
  for (let index = 0; index < width; index += 1) {
    const values = [...new Set(group.map((link) => link.segments[index]))];
    if (values.length <= 1) continue;
    if (!values.every(entityLikeSegment)) return false;
  }
  return true;
}

// Minimum distinct siblings under one prefix before a varying segment reads as a
// parameter rather than a set of distinct pages.
const PARAMETER_FANOUT_MIN = 8;

// Structural generalisation, independent of `entityLikeSegment`: a LARGE fan-out of
// siblings sharing a prefix (e.g. 40 different /celebrity/{name}) is a parameterised
// entity listing, so the varying segment is a parameter even when it is a plain
// human-readable slug (a Chinese name) that no per-segment ID heuristic can catch.
// This reads the crawl's own link STRUCTURE, so the family generalises from links
// alone — ahead of visiting any page. A segment that varies over only a handful of
// values stays literal (distinct pages, e.g. /demo/cart · /demo/search · /demo/about).
function hasParameterFanout(group: Array<{ segments: string[] }>) {
  const width = group[0]?.segments.length || 0;
  let fanoutSegments = 0;
  for (let index = 0; index < width; index += 1) {
    const distinct = new Set(group.map((link) => link.segments[index])).size;
    if (distinct === 1) continue; // constant segment — part of the shared prefix
    if (distinct < PARAMETER_FANOUT_MIN) return false; // few distinct values ⇒ distinct pages, not a parameter
    fanoutSegments += 1;
  }
  return fanoutSegments >= 1;
}

function linkGroups(snapshot: PageSnapshot) {
  const origin = new URL(snapshot.url).origin;
  // Connection payloads come from an external SDK boundary. Older SDK builds
  // did not always include `links`, so treat a missing/non-array value as an
  // empty observation instead of failing the whole site connection.
  const snapshotLinks = Array.isArray(snapshot.links) ? snapshot.links : [];
  const links = snapshotLinks.flatMap((link) => {
    try {
      const url = new URL(link.url, snapshot.url);
      return url.origin === origin ? [{ ...link, parsed: url, segments: segments(url) }] : [];
    } catch { return []; }
  });
  const groups = new Map<string, typeof links>();
  for (const link of links) {
    const key = `${link.parsed.origin}:${link.segments.length}:${link.segments[0] || "/"}`;
    groups.set(key, [...(groups.get(key) || []), link]);
  }
  return [...groups.values()].flatMap((group) => {
    const distinctPaths = new Set(group.map((link) => link.parsed.pathname));
    // A parameterised family is recognised either by every varying segment looking
    // like an entity id (hasTrustedDynamicPath) OR by a large sibling fan-out under a
    // shared prefix (hasParameterFanout) — the latter catches human-readable slugs
    // (人名) that no per-segment ID heuristic can. A few distinct siblings (a nav:
    // /demo/cart · /demo/search · /demo/about) fall through both and stay separate.
    const safeFamily = distinctPaths.size === 1 || hasTrustedDynamicPath(group) || hasParameterFanout(group);
    return safeFamily ? [group] : group.map((link) => [link]);
  });
}

function clusteredTemplate(group: ReturnType<typeof linkGroups>[number]): { template: UrlTemplate; parameters: SceneDefinition["parameters"] } {
  if (group.length === 1) {
    const rawTemplate = urlTemplateFromUrl(group[0].parsed.toString());
    const template = { ...rawTemplate, query: Object.fromEntries(Object.entries(rawTemplate.query).map(([key, value]) => [key, value.match(/^\{(.+)\}$/) ? `{${key}?}` : value])) };
    const bindings = matchUrlTemplate(template, group[0].parsed.toString()) || {};
    const names = [...template.pathnamePattern.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
      .concat(Object.values(template.query).flatMap((value) => value.match(/^\{(.+?)\??\}$/)?.[1] || []));
    return { template, parameters: [...new Set(names)].map((name) => ({ id: name, name, type: "string", required: !Object.values(template.query).some((value) => value.includes(`{${name}`)), examples: bindings[name] === undefined ? [] : [bindings[name]] })) };
  }
  const first = group[0];
  const params: SceneDefinition["parameters"] = [];
  let parameterIndex = 0;
  const pathnamePattern = first.segments.map((segment, index) => {
    const values = [...new Set(group.map((link) => link.segments[index]))];
    if (values.length === 1) return segment;
    parameterIndex += 1;
    const id = `path${parameterIndex}`;
    params.push({ id, name: id, type: "string", required: true, examples: values.slice(0, 8) });
    return `{${id}}`;
  }).join("/");
  const queryKeys = [...new Set(group.flatMap((link) => [...link.parsed.searchParams.keys()]))];
  const query: Record<string, string> = {};
  for (const key of queryKeys) {
    query[key] = `{${key}${group.every((link) => link.parsed.searchParams.has(key)) ? "" : "?"}}`;
    const examples = [...new Set(group.map((link) => link.parsed.searchParams.get(key)).filter((value): value is string => value !== null))].slice(0, 8);
    params.push({ id: key, name: key, type: "string", required: false, examples });
  }
  const normalizedPath = `/${pathnamePattern}`;
  const signature = `${first.parsed.origin}:${normalizedPath}`;
  return { template: { id: `url_${stableHash(signature)}`, originPattern: first.parsed.origin, pathnamePattern: normalizedPath, query }, parameters: params };
}

export function targetFromObservedEvidence(evidence: ElementEvidence, sceneId: string, now: string): TargetSpec {
  const semantic = `${evidence.role || evidence.tag}:${evidence.accessibleName || evidence.label || evidence.name || evidence.href || evidence.cssPath}`;
  const locators: TargetSpec["locatorVariants"] = [];
  const add = (strategy: TargetSpec["locatorVariants"][number]["strategy"], value: string | undefined, score: number) => {
    if (value) locators.push({ id: `locator_${stableHash(`${strategy}:${value}`)}`, strategy, value, role: evidence.role, score, successes: 0, failures: 0, lastSeenAt: now });
  };
  if (evidence.role && evidence.accessibleName) add("role", evidence.accessibleName, 0.96);
  add("label", evidence.label, 0.94); add("placeholder", evidence.placeholder, 0.9); add("name", evidence.name, 0.88);
  add("href-template", evidence.href, 0.84); add("text", evidence.accessibleName, 0.82); add("css", evidence.cssPath, 0.4);
  return { id: `target_${stableHash(semantic)}`, name: evidence.accessibleName || evidence.label || evidence.name || evidence.role || evidence.tag, sceneIds: [sceneId], role: evidence.role, accessibleNames: evidence.accessibleName ? [evidence.accessibleName] : [], attributes: evidence.attributes, locatorVariants: locators, updatedAt: now };
}

function sharedNavigationKnowledge(references: LinkReference[], scenes: SceneDefinition[], now: string) {
  const operations: OperationDefinition[] = [];
  const byDestination = new Map<string, LinkReference[]>();
  for (const reference of references) byDestination.set(reference.toSceneId, [...(byDestination.get(reference.toSceneId) || []), reference]);
  for (const destinationReferences of byDestination.values()) {
    const reference = destinationReferences.toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
    const fromSceneIds = [...new Set(destinationReferences.map((item) => item.fromSceneId))];
    const globallyGrounded = destinationReferences.some((item) => item.landmark === "header")
      || (destinationReferences.some((item) => item.landmark === "nav") && fromSceneIds.length >= 2);
    // A <nav> landmark can also be local pagination, a carousel or a date
    // switcher. It only becomes shared after the same destination is observed
    // from multiple Scene identities; a header link is global immediately.
    if (!globallyGrounded) continue;
    const scene = scenes.find((item) => item.id === reference.toSceneId);
    if (!scene || scene.parameters.some((parameter) => parameter.required)) continue;
    const operationId = `operation_shared_nav_${stableHash(scene.id)}`;
    const verified = scene.directEntry === "verified" || scene.evidenceStatus === "observed" || scene.evidenceStatus === "entry-verified";
    operations.push({
      id: operationId,
      name: `前往${scene.name}`,
      kind: "navigation",
      evidenceSource: "shared-navigation",
      applicability: verified
        ? { scope: "any-scene", evidenceSceneIds: fromSceneIds }
        : { scope: "scene-set", sceneIds: fromSceneIds, evidenceSceneIds: fromSceneIds },
      // A header/nav landmark is a site-wide affordance. Its reusable meaning
      // is the destination, not the incidental page where one user clicked it.
      fromSceneId: "*",
      toSceneId: scene.id,
      inputs: { type: "object", properties: {} },
      outputs: {
        type: "object",
        properties: {
          pageUrl: { type: "string", description: "到达页面 URL" },
          pageTitle: { type: "string", description: "到达页面标题" },
        },
        required: ["pageUrl", "pageTitle"],
      },
      preconditions: [],
      effects: [`scene:${scene.id}`],
      implementations: [{
        id: `implementation_shared_nav_${stableHash(scene.id)}`,
        program: { version: 2, steps: [{ id: `step_nav_${stableHash(scene.id)}`, op: "navigate", sceneId: scene.id, bindings: {}, timeoutMs: 10_000 }] },
        conditions: [], successes: verified ? 1 : 0, failures: 0, sourceEpisodeIds: [],
      }],
      verification: { sceneId: scene.id },
      status: verified ? "verified" : "candidate",
      updatedAt: now,
    });
  }
  return {
    operations: [...new Map(operations.map((item) => [item.id, item])).values()],
    capabilities: [],
  };
}

export function discoverInitialKnowledge(snapshot: PageSnapshot, existingScenes: SceneDefinition[] = [], existingReferences: LinkReference[] = []) {
  const recognized = recognizeScene(existingScenes, snapshot);
  const observed = sceneFromSnapshot(snapshot);
  const knownCurrent = recognized ? existingScenes.find((scene) => scene.id === recognized.sceneId) : undefined;
  const currentScene = knownCurrent ? mergeSceneEvidence(knownCurrent, observed) : observed;
  const scenes = new Map<string, SceneDefinition>([[currentScene.id, currentScene]]);
  for (const group of linkGroups(snapshot)) {
    const { template, parameters } = clusteredTemplate(group);
    const dynamic = parameters.length > 0;
    const label = dynamic ? `${group[0].segments[0] || "页面"}详情` : (isErrorTitle(group[0].text) ? undefined : group[0].text);
    const id = `scene_${stableHash(`${siteIdentityOrigin(template.originPattern)}:${template.pathnamePattern}`)}`;
    if (!scenes.has(id)) {
      const candidate: SceneDefinition = {
        id, name: label || template.pathnamePattern, semanticSource: "program", evidenceStatus: "referenced", lifecycle: "referenced",
        identityConfidence: group.length >= 3 ? 0.78 : dynamic ? 0.62 : 0.72,
        evidence: {
          linkLabels: [...new Set(group.map((item) => item.text).filter(Boolean))].slice(0, 20),
          observedUrls: [], titles: [], headings: [],
        },
        urlTemplates: [template], parameters, verifier: {}, directEntry: "candidate",
        sourceObservationIds: [snapshot.id], createdAt: snapshot.capturedAt, updatedAt: snapshot.capturedAt,
      };
      const previous = existingScenes.find((scene) => scene.id === id);
      scenes.set(id, previous ? mergeSceneEvidence(previous, candidate) : candidate);
    }
  }
  const discoveredScenes = [...scenes.values()];
  const evidenceByHref = new Map((snapshot.elements || []).flatMap((item) => item.href ? [[item.href, item] as const] : []));
  const linkReferences: LinkReference[] = [];
  const snapshotLinks = Array.isArray(snapshot.links) ? snapshot.links : [];
  for (const link of snapshotLinks) {
    // Parameterized families can legitimately link between two instances of the
    // same Scene (for example, previous/next dates). Keep that self-edge as
    // contextual graph evidence; sharedNavigationKnowledge still requires
    // cross-Scene/global evidence before promoting it to a reusable operation.
    const toScene = discoveredScenes.find((scene) =>
      scene.urlTemplates.some((template) => matchUrlTemplate(template, link.url) !== null));
    if (!toScene) continue;
    const evidence = evidenceByHref.get(link.url);
    linkReferences.push({
      id: `link_${stableHash(`${currentScene.id}:${toScene.id}:${link.url}:${link.text}`)}`,
      fromSceneId: currentScene.id, toSceneId: toScene.id, label: link.text, href: link.url,
      landmark: evidence?.landmark || "unknown", observations: 1,
      firstSeenAt: snapshot.capturedAt, lastSeenAt: snapshot.capturedAt,
    });
  }
  const sharedNavigation = sharedNavigationKnowledge([...existingReferences, ...linkReferences], [...existingScenes, ...discoveredScenes], snapshot.capturedAt);
  return {
    scenes: [...new Map(discoveredScenes.map((scene) => [scene.id, scene])).values()],
    linkReferences: [...new Map(linkReferences.map((reference) => [reference.id, reference])).values()],
    targets: [] as TargetSpec[], operations: sharedNavigation.operations, capabilities: sharedNavigation.capabilities,
  };
}

export function discoverTransitionKnowledge(release: SiteAgentReleaseV2, observations: TransitionObservation[]) {
  const scenes = new Map(release.scenes.map((scene) => [scene.id, scene]));
  const touchedScenes = new Set<string>();
  const linkReferences = new Map((release.linkReferences || []).map((reference) => [reference.id, reference]));
  const touchedReferences = new Set<string>();
  const targets = new Map<string, TargetSpec>();
  const operations = new Map<string, OperationDefinition>();

  for (const observation of observations) {
    for (const snapshot of [observation.fromSnapshot, observation.toSnapshot]) {
      if (!snapshot) continue;
      const discovered = discoverInitialKnowledge(snapshot, [...scenes.values()], [...linkReferences.values()]);
      for (const scene of discovered.scenes) {
        const previous = scenes.get(scene.id);
        const merged = previous ? mergeSceneEvidence(previous, scene) : scene;
        if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) touchedScenes.add(scene.id);
        scenes.set(scene.id, merged);
      }
      for (const reference of discovered.linkReferences) {
        const previous = linkReferences.get(reference.id);
        linkReferences.set(reference.id, previous ? { ...previous, observations: previous.observations + 1, lastSeenAt: reference.lastSeenAt } : reference);
        touchedReferences.add(reference.id);
      }
      for (const operation of discovered.operations) operations.set(operation.id, operation);
    }

    const fromSceneId = observation.fromSnapshot
      ? recognizeScene([...scenes.values()], observation.fromSnapshot)?.sceneId
      : observation.fromScene?.sceneId;
    const toSceneId = observation.toSnapshot
      ? recognizeScene([...scenes.values()], observation.toSnapshot)?.sceneId
      : observation.toScene?.sceneId;
    if (!fromSceneId || !toSceneId || !observation.steps.length) continue;

    for (const evidence of observation.elementEvidence) {
      const target = targetFromObservedEvidence(evidence, fromSceneId, observation.endedAt);
      if (!release.targets.some((item) => item.id === target.id)) targets.set(target.id, target);
    }
    const id = `operation_${stableHash(`${fromSceneId}:${toSceneId}:business-transition`)}`;
    const toScene = scenes.get(toSceneId);
    const implementation = {
      id: `implementation_${stableHash(`${id}:${observation.steps.map((step) => `${step.op}:${"targetId" in step ? step.targetId || "" : ""}`).join(",")}`)}`,
      program: { version: 2 as const, steps: observation.steps },
      conditions: [], successes: 1, failures: 0, sourceEpisodeIds: [],
    };
    const existing = operations.get(id) || release.operations.find((item) => item.id === id);
    operations.set(id, existing ? {
      ...existing,
      implementations: existing.implementations.some((item) => item.id === implementation.id)
        ? existing.implementations.map((item) => item.id === implementation.id ? { ...item, successes: item.successes + 1 } : item)
        : [...existing.implementations, implementation],
      updatedAt: observation.endedAt,
    } : {
      id,
      name: `前往${toScene?.name || observation.toSnapshot?.heading || "下一页面"}`,
      kind: "business-transition",
      evidenceSource: "observed-transition",
      applicability: { scope: "scene-set", sceneIds: [fromSceneId], evidenceSceneIds: [fromSceneId] },
      fromSceneId,
      toSceneId,
      inputs: { type: "object", properties: {} },
      outputs: { type: "object", properties: {} },
      preconditions: [],
      effects: [`scene:${toSceneId}`],
      implementations: [implementation],
      verification: { sceneId: toSceneId },
      status: "candidate",
      updatedAt: observation.endedAt,
    });
  }

  return {
    scenes: [...scenes.values()].filter((scene) => touchedScenes.has(scene.id)),
    linkReferences: [...linkReferences.values()].filter((reference) => touchedReferences.has(reference.id)),
    targets: [...targets.values()],
    operations: [...operations.values()],
    capabilities: [],
  };
}
