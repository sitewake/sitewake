import {
  EVIDENCE_RANK,
  mergeOrigins,
  stableHash,
  strongerEvidenceStatus,
  withAgentConfigDefaults,
  type CapabilityDefinition,
  type LinkReference,
  type SceneDefinition,
  type SiteAgentReleaseV2,
} from "./protocol";
import { classifyGoal, compileNavigationTools, isTechnicalCapabilityAdapterId } from "./navigation-tools";
import { clusterLinkReferences } from "./link-aggregation";
import { siteIdentityOrigin } from "./url-scene";
import { deriveCapabilityTaskTemplates } from "./site-knowledge";

// Kept in sync with url-scene.ts `dynamicSegment`: a name/date/id path segment marks one
// INSTANCE of a family, so canonicalize collapses the family's literal scenes onto one
// route ON READ — this is what cleans up an already-adopted release full of
// /celebrity/李宏毅 rows without needing a re-crawl.
function entityLikeSegment(segment: string) {
  let value = segment;
  try { value = decodeURIComponent(segment); } catch { /* percent-decode failed — match the raw form */ }
  return /^\d{3,}$/.test(segment)
    || /^[0-9a-f]{8,}$/i.test(segment)
    || /^[a-z0-9_-]{18,}$/i.test(segment)
    || /[㐀-鿿]/.test(value)
    || /^\d{4}-\d{2}(?:-\d{2})?$/.test(value)
    || (/^[A-Za-z0-9_-]{5,}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value));
}

function pathSegments(scene: SceneDefinition) {
  return (scene.urlTemplates[0]?.pathnamePattern || "/").split("/").filter(Boolean);
}

function familyPath(scene: SceneDefinition, scenes: SceneDefinition[]) {
  const template = scene.urlTemplates[0];
  if (!template) return scene.id;
  const segments = pathSegments(scene);
  if (segments.length < 2) return template.pathnamePattern;
  const identity = siteIdentityOrigin(template.originPattern);
  const family = scenes.filter((item) => {
    const candidate = item.urlTemplates[0];
    const candidateSegments = pathSegments(item);
    return Boolean(candidate) && siteIdentityOrigin(candidate!.originPattern) === identity && candidateSegments.length === segments.length && candidateSegments[0] === segments[0];
  });
  let parameterIndex = 0;
  const promoted = segments.map((segment, index) => {
    const values = new Set(family.map((item) => pathSegments(item)[index]));
    if (values.size <= 1) return segment;
    const concreteValues = [...values].filter((value) => !/^\{[^}]+\}$/.test(value));
    const placeholderExamples = new Set(family.flatMap((item) => {
      const placeholder = pathSegments(item)[index]?.match(/^\{([^}]+)\}$/)?.[1];
      if (!placeholder) return [];
      return item.parameters.find((parameter) => parameter.id === placeholder)?.examples || [];
    }));
    const hasPlaceholder = concreteValues.length < values.size;
    // Dynamic evidence is local to one path position. An existing placeholder
    // or an all-identifier set can parameterize that position; a parameter in
    // another position must not turn static actions such as /edit and /view
    // into a second route parameter. When a placeholder already exists the
    // position is a PROVEN parameter, so a few literal siblings that don't match
    // the id heuristic (a name like "BTS"/"Lisa") must still FOLD in as instances
    // rather than block the whole family — require only a MAJORITY there, which
    // still rejects a distinct page (/shop/cart) sitting next to /shop/{id}.
    // A referenced-only sibling (a URL we've merely SEEN as a link, never fetched)
    // that sits at a position an existing placeholder already PROVED to be a route
    // parameter is an un-fetched INSTANCE of that family — fold it in even when its
    // slug fails the id heuristic (e.g. "BLACKPINK"/"Lisa"), per the intent above.
    // General: any family with a proven placeholder here, matched by structure — no
    // per-site hardcoding. A sibling that was actually crawled keeps its own identity
    // (only "referenced" folds), so a real distinct page like /shop/cart is unaffected.
    const referencedInstanceValues = new Set(
      family
        .filter((item) => (item.evidenceStatus || item.lifecycle) === "referenced")
        .map((item) => pathSegments(item)[index])
        .filter((value): value is string => Boolean(value) && !/^\{[^}]+\}$/.test(value)),
    );
    const instanceLike = (value: string) => entityLikeSegment(value) || placeholderExamples.has(value) || referencedInstanceValues.has(value);
    const dynamic = (hasPlaceholder && (concreteValues.length === 0 || concreteValues.filter(instanceLike).length >= concreteValues.length * 0.6))
      || (!hasPlaceholder && concreteValues.length > 0 && concreteValues.every(entityLikeSegment));
    if (!dynamic) return segment;
    parameterIndex += 1;
    return `{path${parameterIndex}}`;
  });
  return `/${promoted.join("/")}`;
}

/** Identity, not address: the scheme is deliberately absent — see `siteIdentityOrigin`. */
function keyOf(scene: SceneDefinition, scenes: SceneDefinition[]) {
  return `${sceneIdentityOrigin(scene)}:${familyPath(scene, scenes)}`;
}

function sceneIdentityOrigin(scene: SceneDefinition) {
  const template = scene.urlTemplates[0];
  return template ? siteIdentityOrigin(template.originPattern) : "*";
}

/**
 * Which member's origin the merged Scene should be addressed by. An http/https pair merges
 * into ONE Scene, so the survivor must be the origin we actually reached — the strongest
 * evidence rung wins, and https breaks a tie. Picking the name-score winner instead could
 * hand navigation the plaintext twin that was never verified.
 */
function addressOrigin(members: SceneDefinition[]) {
  const rung = (scene: SceneDefinition) => EVIDENCE_RANK[strongerEvidenceStatus(scene.evidenceStatus, scene.lifecycle)];
  const secure = (scene: SceneDefinition) => Number(scene.urlTemplates[0]?.originPattern.startsWith("https:"));
  return [...members].sort((left, right) => rung(right) - rung(left) || secure(right) - secure(left))[0]
    ?.urlTemplates[0]?.originPattern;
}

function nameScore(scene: SceneDefinition) {
  let score = scene.description ? 30 : 0;
  score += Math.min(scene.name.length, 20);
  if (/详情$/.test(scene.name) || /^(search|guides|city|country|celebrity|topic)/i.test(scene.name)) score -= 20;
  return score;
}

function normalizeDateExample(value: string) {
  const match = value.match(/(?:^|[^\d])(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|号)?(?:[^\d]|$)/);
  if (!match) return undefined;
  return `${match[1]}-${Number(match[2]).toString().padStart(2, "0")}-${Number(match[3]).toString().padStart(2, "0")}`;
}

function capabilityInputHints(capability: SiteAgentReleaseV2["capabilities"][number]) {
  const corpus = [capability.name, capability.description, capability.goalTemplate || "", ...capability.aliases].join(" ");
  const observedDate = normalizeDateExample(corpus);
  return {
    ...capability.inputs,
    properties: Object.fromEntries(Object.entries(capability.inputs.properties || {}).map(([id, field]) => {
      const dateLike = field.type === "string" && /(?:^date$|日期|年月日|yyyy)/i.test(`${id} ${field.description || ""}`);
      return [id, {
        ...field,
        description: field.description || id,
        ...(dateLike && !field.format ? { format: "date" as const } : {}),
        ...(dateLike && !field.examples?.length ? { examples: [observedDate || "2025-04-24"] } : {}),
      }];
    })),
  };
}

/** Collapses legacy query-key Scene identities into the v2 route identity. */
export function canonicalizeReleaseKnowledge(release: SiteAgentReleaseV2): SiteAgentReleaseV2 {
  release = withAgentConfigDefaults(release);
  // Profile semantics may be AI-authored or retained from an older production
  // hostname. Browser execution authority comes from allowed Origins and Scene
  // evidence, never from that descriptive field.
  const allowedOriginValues = release.profile && Array.isArray(release.profile.allowedOrigins) ? release.profile.allowedOrigins : [];
  const allowedOrigins = allowedOriginValues.flatMap((value) => {
    try { return [new URL(value).origin]; } catch { return []; }
  });
  if (allowedOrigins.length) {
    let entryTrusted = false;
    try { entryTrusted = Boolean(release.profile.entryUrl && allowedOrigins.includes(new URL(release.profile.entryUrl).origin)); } catch { /* normalize below */ }
    if (!entryTrusted) release = { ...release, profile: { ...release.profile, entryUrl: `${allowedOrigins[0]}/` } };
  }
  // Kind describes semantics; exposure describes call visibility. They are
  // orthogonal: a navigation capability may be public and a business
  // capability may be internal. Technical NavigationTool compatibility
  // adapters are not Capability contracts and are removed before any semantic
  // canonicalization; old persisted Release rows remain untouched.
  const capabilityExposure = (capability: CapabilityDefinition) => {
    if (capability.exposure) return capability.exposure;
    return "public" as const;
  };
  // Every public Capability is a callable contract. Older releases only
  // described side effects; expose the universally verifiable result page so
  // callers always receive a value while newer AI-authored contracts add
  // business-specific extracted fields.
  release = {
    ...release,
    capabilities: release.capabilities
      .filter((capability) => !isTechnicalCapabilityAdapterId(capability.id))
      .map((capability) => Object.keys(capability.outputs.properties || {}).length ? {
      ...capability,
      inputs: capabilityInputHints(capability),
      exposure: capabilityExposure(capability),
      resultKind: capability.resultKind || "page",
    } : {
      ...capability,
      inputs: capabilityInputHints(capability),
      exposure: capabilityExposure(capability),
      resultKind: capability.resultKind || "page",
      outputs: {
        type: "object" as const,
        properties: {
          pageUrl: { type: "string" as const, description: "完成目标后的页面地址" },
          pageTitle: { type: "string" as const, description: "完成目标后的页面标题" },
        },
        required: ["pageUrl", "pageTitle"],
      },
      plans: capability.plans.map((plan) => ({
        ...plan,
        outputBindings: {
          pageUrl: { source: "state" as const, path: "__pageUrl" },
          pageTitle: { source: "state" as const, path: "__pageTitle" },
          ...plan.outputBindings,
        },
      })),
    }),
  };
  // Repair the legacy authoring bug that labelled every learned program a
  // business task. A pure navigation request whose only output is page
  // identity is navigation even when its destination is a business page.
  const pageMetadataOutputs = new Set(["pageUrl", "pageTitle", "pageHeading", "sceneId"]);
  release = {
    ...release,
    capabilities: release.capabilities.map((capability) => {
      const goal = capability.goalTemplate || capability.name;
      const onlyPageMetadata = Object.keys(capability.outputs.properties || {}).every((key) => pageMetadataOutputs.has(key));
      const kind = classifyGoal(goal) === "navigation" && onlyPageMetadata
        ? "navigation" as const
        : capability.kind || "task" as const;
      return { ...capability, kind };
    }),
  };
  const retainedOperations = release.operations.filter((operation) => operation.implementations.some((implementation) => Boolean(implementation.authored?.proof)) || operation.evidenceSource === "observed-transition" || operation.evidenceSource === "legacy-link" || operation.kind === "navigation" || Boolean(operation.applicability && (operation.status === "verified" || operation.status === "published") && operation.implementations.length > 0));
  const operationById = new Map(retainedOperations.map((operation) => [operation.id, operation]));
  const authoredCapabilities = release.capabilities.filter((capability) =>
    // A Revision-owned program is a complete implementation in its own right.
    // It does not need to be wrapped in the legacy Operation/Plan graph merely
    // to survive release canonicalization.
    Boolean(capability.module)
    || (capability.plans.length > 0 && capability.plans.every((plan) =>
      plan.steps.length > 0 && plan.steps.every((step) => {
        const operation = operationById.get(step.operationId);
        if (!operation) return false;
        const verifiedSharedOperation = Boolean(operation.applicability && (operation.status === "verified" || operation.status === "published") && operation.implementations.length > 0);
        return capability.kind === "navigation" || verifiedSharedOperation || operation.implementations.some((implementation) => Boolean(implementation.authored?.proof));
      }))));
  release = {
    ...release,
    capabilities: authoredCapabilities,
    operations: retainedOperations,
  };
  const groups = new Map<string, SceneDefinition[]>();
  for (const scene of release.scenes) {
    const key = keyOf(scene, release.scenes);
    groups.set(key, [...(groups.get(key) || []), scene]);
  }
  const remap = new Map<string, string>();
  const scenes = [...groups.entries()].map(([key, members]) => {
    const id = `scene_${stableHash(key)}`;
    for (const member of members) remap.set(member.id, id);
    const preferred = [...members].sort((left, right) => nameScore(right) - nameScore(left))[0];
    const firstTemplate = preferred.urlTemplates[0];
    const promotedPath = key.slice(sceneIdentityOrigin(preferred).length + 1);
    const query = Object.assign({}, ...members.flatMap((scene) => scene.urlTemplates.map((template) => template.query)));
    const parameters = new Map<string, SceneDefinition["parameters"][number]>();
    for (const parameter of members.flatMap((scene) => scene.parameters)) {
      const previous = parameters.get(parameter.id);
      parameters.set(parameter.id, previous ? { ...previous, ...parameter, required: previous.required && parameter.required, examples: [...new Set([...previous.examples, ...parameter.examples])].slice(0, 12) } : parameter);
    }
    const memberSegments = members.map(pathSegments);
    const promotedSegments = promotedPath.split("/").filter(Boolean);
    for (const match of promotedPath.matchAll(/\{([^}]+)\}/g)) {
      const id = match[1];
      const segmentIndex = promotedSegments.findIndex((segment) => segment === `{${id}}`);
      // Fold each member's literal value at this position into the parameter's examples —
      // including literals that just folded in from referenced-only sibling scenes, so a
      // /celebrity/BLACKPINK sibling becomes an example of /celebrity/{path1} rather than
      // being dropped when the parameter already existed.
      const segmentExamples = [...new Set(memberSegments.map((segments) => segments[segmentIndex]).filter((value) => value && !/^\{/.test(value)))];
      const existing = parameters.get(id);
      parameters.set(id, existing
        ? { ...existing, examples: [...new Set([...existing.examples, ...segmentExamples])].slice(0, 16) }
        : { id, name: id, type: "string", required: true, examples: segmentExamples.slice(0, 16) });
    }
    const evidenceStatus = members.reduce<SceneDefinition["evidenceStatus"]>(
      (strongest, scene) => strongerEvidenceStatus(strongest, strongerEvidenceStatus(scene.evidenceStatus, scene.lifecycle)),
      "referenced",
    );
    const origins = mergeOrigins(...members.flatMap((scene) => [scene.origins, scene.origin]));
    const evidence = {
      linkLabels: [...new Set(members.flatMap((scene) => scene.evidence?.linkLabels || []))].slice(0, 30),
      observedUrls: [...new Set(members.flatMap((scene) => scene.evidence?.observedUrls || []))].slice(-30),
      titles: [...new Set(members.flatMap((scene) => scene.evidence?.titles || []))].slice(-30),
      headings: [...new Set(members.flatMap((scene) => scene.evidence?.headings || []))].slice(-30),
    };
    return {
      ...preferred,
      id,
      evidenceStatus,
      lifecycle: evidenceStatus,
      origin: origins?.includes("usage") ? "usage" : origins?.[0] || preferred.origin,
      origins,
      evidence,
      identityConfidence: Math.max(...members.map((scene) => scene.identityConfidence || 0.5)),
      urlTemplates: firstTemplate ? [{ ...firstTemplate, id: `url_${stableHash(key)}`, originPattern: addressOrigin(members) || firstTemplate.originPattern, pathnamePattern: promotedPath, query }] : preferred.urlTemplates,
      parameters: [...parameters.values()],
      // needs-reverify must survive canonicalization: a scene that was verified and
      // then demoted on a usage failure is awaiting re-check, not an unproven candidate.
      // Collapsing it to "candidate" here silently erased every drift demotion (the
      // re-verify sweep looks for needs-reverify, so it would never see them again).
      directEntry: members.some((scene) => scene.directEntry === "verified") ? "verified" : members.some((scene) => scene.directEntry === "needs-reverify") ? "needs-reverify" : members.every((scene) => scene.directEntry === "failed") ? "failed" : "candidate",
      sourceObservationIds: [...new Set(members.flatMap((scene) => scene.sourceObservationIds))].slice(-8),
      // When several merge into one, the first appearance time is the earliest.
      createdAt: members.map((scene) => scene.createdAt).filter((value): value is string => Boolean(value)).sort()[0],
      updatedAt: [...members].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].updatedAt,
    } satisfies SceneDefinition;
  });
  const mapId = (id: string | undefined) => id ? remap.get(id) || id : id;
  const operations = release.operations.map((operation) => {
    const implementations = operation.implementations.map((implementation) => {
      const remapProgram = (program: typeof implementation.program) => ({
        ...program,
        steps: program.steps.map((step) => ({
          ...step,
          ...("sceneId" in step ? { sceneId: mapId(step.sceneId)! } : {}),
          ...("transition" in step && step.transition ? {
            transition: {
              ...step.transition,
              expectedSceneIds: [...new Set(step.transition.expectedSceneIds.map((sceneId) => mapId(sceneId)!).filter(Boolean))],
            },
          } : {}),
        })),
      });
      const proof = implementation.authored?.proof;
      const remapVerifier = (verifier: NonNullable<typeof proof>["verifier"]) => ({
        ...verifier,
        success: verifier.success.map((rule) => rule.kind === "scene" ? { ...rule, value: mapId(rule.value)! } : rule),
        noResult: verifier.noResult,
        businessRejection: verifier.businessRejection,
      });
      const mappedAuthored = implementation.authored?.kind === "page-program"
        ? { ...implementation.authored, program: remapProgram(implementation.authored.program), proof: { ...implementation.authored.proof, verifier: remapVerifier(implementation.authored.proof.verifier) } }
        : implementation.authored
          ? { ...implementation.authored, proof: { ...implementation.authored.proof, verifier: remapVerifier(implementation.authored.proof.verifier) } }
          : implementation.authored;
      if (!proof) return { ...implementation, program: remapProgram(implementation.program), authored: mappedAuthored };
      const mappedProof = mappedAuthored!.proof;
      const dynamic = mappedProof.verifier.success.some((rule) => rule.kind === "input-visible");
      const structural = mappedProof.verifier.success.some((rule) => rule.kind === "scene" || rule.kind === "url" || rule.kind === "target");
      if (!dynamic || !structural) return { ...implementation, program: remapProgram(implementation.program), authored: mappedAuthored };
      return {
        ...implementation,
        program: remapProgram(implementation.program),
        authored: {
          ...mappedAuthored!,
          proof: { ...mappedProof, verifier: { ...mappedProof.verifier, success: mappedProof.verifier.success.filter((rule) => rule.kind !== "text") } },
        },
      };
    });
    const dynamicStructural = implementations.some((implementation) => {
      const rules = implementation.authored?.proof.verifier.success || [];
      return rules.some((rule) => rule.kind === "input-visible") && rules.some((rule) => rule.kind === "scene" || rule.kind === "url" || rule.kind === "target");
    });
    return {
      ...operation,
      implementations,
      applicability: operation.applicability ? {
        ...operation.applicability,
        sceneIds: operation.applicability.sceneIds?.map((sceneId) => mapId(sceneId)!).filter(Boolean),
        evidenceSceneIds: operation.applicability.evidenceSceneIds.map((sceneId) => mapId(sceneId)!).filter(Boolean),
      } : operation.fromSceneId === "*" ? { scope: "any-scene" as const, evidenceSceneIds: [] } : { scope: "scene-set" as const, sceneIds: [mapId(operation.fromSceneId)!], evidenceSceneIds: [mapId(operation.fromSceneId)!] },
      fromSceneId: operation.fromSceneId === "*" ? "*" : mapId(operation.fromSceneId)!,
      toSceneId: mapId(operation.toSceneId),
      verification: { ...operation.verification, sceneId: mapId(operation.verification.sceneId), textIncludes: dynamicStructural ? [] : operation.verification.textIncludes },
    };
  });
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  // Old Releases can contain either side of a stale pointer: a retired Scene
  // inside PageProgram, or an incorrect Operation endpoint while the grounded
  // program and verifier still agree. Reconcile all three representations.
  const stabilizedOperations = operations.map((operation) => {
    const stabilizeProgram = (program: (typeof operation.implementations)[number]["program"]) => ({
      ...program,
      steps: program.steps.map((step) => ({
        ...step,
        ...(step.op === "navigate" && !sceneById.has(step.sceneId) && operation.toSceneId && sceneById.has(operation.toSceneId) ? { sceneId: operation.toSceneId } : {}),
        ...("transition" in step && step.transition ? {
          transition: {
            ...step.transition,
            expectedSceneIds: step.transition.expectedSceneIds.map((sceneId) => sceneById.has(sceneId) ? sceneId : operation.toSceneId && sceneById.has(operation.toSceneId) ? operation.toSceneId : sceneId),
          },
        } : {}),
      })),
    });
    const stabilizeProof = (proof: NonNullable<(typeof operation.implementations)[number]["authored"]>["proof"]) => ({
      ...proof,
      verifier: {
        ...proof.verifier,
        success: proof.verifier.success.map((rule) => rule.kind === "scene" && !sceneById.has(rule.value) && operation.toSceneId && sceneById.has(operation.toSceneId) ? { ...rule, value: operation.toSceneId } : rule),
      },
    });
    const implementations = operation.implementations.map((implementation) => {
      const authored = implementation.authored
        ? {
          ...implementation.authored,
          ...(implementation.authored.kind === "page-program" ? { program: stabilizeProgram(implementation.authored.program) } : {}),
          proof: stabilizeProof(implementation.authored.proof),
        }
        : implementation.authored;
      return { ...implementation, program: stabilizeProgram(implementation.program), authored };
    });
    const groundedDestinations = [...new Set(implementations.flatMap((implementation) => implementation.program.steps.flatMap((step) => step.op === "navigate" && sceneById.has(step.sceneId) ? [step.sceneId] : [])))];
    const toSceneId = groundedDestinations.length === 1 ? groundedDestinations[0] : operation.toSceneId;
    return {
      ...operation,
      implementations,
      toSceneId,
      effects: toSceneId ? [...new Set([...operation.effects.filter((effect) => !effect.startsWith("scene:")), `scene:${toSceneId}`])] : operation.effects,
      verification: { ...operation.verification, sceneId: toSceneId || operation.verification.sceneId },
    };
  });
  // Header navigation is reusable, while local pagination is contextual. Old
  // releases sometimes promoted a concrete date link before its destination
  // was clustered into /daily/{date}. Once the Scene is parameterized, a
  // zero-input shared navigation program is invalid and must be removed.
  const validOperations = stabilizedOperations.filter((operation) => {
    if (operation.evidenceSource !== "shared-navigation" || !operation.toSceneId) return true;
    const destination = sceneById.get(operation.toSceneId);
    const required = destination?.parameters.filter((parameter) => parameter.required) || [];
    return required.length === 0 || required.every((parameter) => Boolean(operation.inputs.properties?.[parameter.id]));
  });
  // Scene clustering can remap multiple historical navigation IDs to one
  // destination. Keep one semantic action and prefer the widest, verified
  // direct-entry implementation instead of exposing duplicates to Planner.
  const navigationByEffect = new Map<string, (typeof validOperations)[number]>();
  const nonNavigation: typeof validOperations = [];
  const operationScore = (operation: (typeof validOperations)[number]) => (operation.status === "published" ? 30 : operation.status === "verified" ? 20 : 0) + (operation.applicability?.scope === "any-scene" ? 10 : operation.applicability?.scope === "scene-set" ? 5 : 0) + (operation.evidenceSource === "shared-navigation" ? 3 : 0);
  for (const operation of validOperations) {
    if (operation.kind !== "navigation" && operation.evidenceSource !== "shared-navigation") { nonNavigation.push(operation); continue; }
    // Query and hash state can intentionally share one canonical Scene. An
    // authored navigation to `/search?sort=price-low` is therefore not the
    // same effect as opening the unfiltered `/search` page even though both
    // operations have the same toSceneId and input schema. Preserve distinct
    // proven URL states while still collapsing historical aliases that prove
    // the same destination.
    const provenUrls = [...new Set(operation.implementations.flatMap((implementation) =>
      implementation.authored?.proof.verifier.success.flatMap((rule) => rule.kind === "url" ? [rule.value] : []) || [],
    ))].sort();
    const key = `${operation.toSceneId || operation.effects.join("|")}:${JSON.stringify(operation.inputs)}:${JSON.stringify(provenUrls)}`;
    const previous = navigationByEffect.get(key);
    if (!previous || operationScore(operation) > operationScore(previous)) navigationByEffect.set(key, operation);
  }
  const canonicalOperations = [...nonNavigation, ...navigationByEffect.values()];
  const dynamicallyVerifiedOutcomeIds = new Set(canonicalOperations.flatMap((operation) => {
    const rules = operation.implementations.flatMap((implementation) => implementation.authored?.proof.verifier.success || []);
    const dynamicStructural = rules.some((rule) => rule.kind === "input-visible") && rules.some((rule) => rule.kind === "scene" || rule.kind === "url" || rule.kind === "target");
    return dynamicStructural ? operation.verification.outcomeIds || [] : [];
  }));
  const referencedTargetIds = new Set([
    ...operations.flatMap((operation) => operation.implementations.flatMap((implementation) => implementation.program.steps.flatMap((step) => "targetId" in step && step.targetId ? [step.targetId] : []))),
    ...operations.flatMap((operation) => operation.verification.targetIds || []),
    ...release.capabilities.flatMap((capability) => capability.outcomes.flatMap((outcome) => outcome.classifiers.flatMap((classifier) => classifier.kind === "target" ? [classifier.value] : []))),
  ]);
  const references = (release.linkReferences || []).map((reference) => ({ ...reference, fromSceneId: mapId(reference.fromSceneId)!, toSceneId: mapId(reference.toSceneId)! }));
  // Cluster to one link per (from,to,landmark) — shared with the crawl aggregation path.
  const clusteredReferences = clusterLinkReferences(references);
  const explicitCapabilityExposures = new Map(release.capabilities.flatMap((capability) =>
    capability.exposure ? [[capability.id, capability.exposure] as const] : []));
  const compiled = compileNavigationTools({
    ...release,
    scenes,
    targets: release.targets.filter((target) => referencedTargetIds.has(target.id)).map((target) => ({ ...target, sceneIds: [...new Set(target.sceneIds.map((id) => mapId(id)!))] })),
    operations: canonicalOperations,
    capabilities: release.capabilities.filter((capability) =>
      Boolean(capability.module)
      || capability.plans.every((plan) =>
        plan.steps.every((step) =>
          canonicalOperations.some((operation) => operation.id === step.operationId)))).map((capability) => ({
      ...capability,
      outcomes: capability.outcomes.map((outcome) => dynamicallyVerifiedOutcomeIds.has(outcome.id) ? { ...outcome, classifiers: outcome.classifiers.filter((classifier) => classifier.kind !== "text") } : outcome),
      // A module-backed Revision executes through its pinned program. Legacy
      // plans are optional compatibility metadata; discard only the plans
      // whose Operations were superseded during canonicalization so the
      // published graph never contains dangling references.
      plans: capability.plans
        .filter((plan) => !capability.module || plan.steps.every((step) =>
          canonicalOperations.some((operation) => operation.id === step.operationId)))
        .map((plan) => ({ ...plan, entrySceneIds: [...new Set(plan.entrySceneIds.map((id) => mapId(id)!))] })),
    })),
    linkReferences: clusteredReferences,
  });
  const canonical = {
    ...compiled,
    capabilities: compiled.capabilities.map((capability) => {
      const exposure = explicitCapabilityExposures.get(capability.id);
      return exposure ? { ...capability, exposure } : capability;
    }),
  };
  // Canonicalization changes executable identity (Scene references, programs
  // and sometimes the public capability set). Returning the persisted hash
  // would let browsers reuse an ETag for different runtime bytes and keep a
  // stale verifier until another Release happened to publish.
  const taskTemplates = deriveCapabilityTaskTemplates(canonical.capabilities, canonical.navigationTools || []);
  const withSuggestions = withAgentConfigDefaults({
    ...canonical,
    profile: {
      ...canonical.profile,
      taskTemplates,
      suggestedGoals: taskTemplates.map((task) => task.name),
    },
  });
  const hashable = { ...withSuggestions, contentHash: undefined, knowledgeRevision: undefined };
  return { ...withSuggestions, contentHash: stableHash(JSON.stringify(hashable)) };
}
