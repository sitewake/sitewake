import { stableHash, type LinkReference } from "./protocol";

/**
 * Link aggregation for the structure knowledge (aggregate-knowledge-links).
 *
 * A link is a relationship between page TYPES (scenes), not page instances — yet the crawl
 * builds one LinkReference per concrete `from:to:href:anchor`, so a page linking to N
 * instances of another produces N stored edges, and site-wide nav (header/footer repeated on
 * every page) explodes into a near-complete graph. These helpers collapse that:
 *  - `collapseGlobalNav`: site-wide nav → one `fromSceneId:"*"` link per target.
 *  - `clusterLinkReferences`: one link per (from, to, landmark), merging evidence.
 * The derived topology reads the result the same as before (`"*"` → `site-root → target`).
 */

const NAV_LANDMARKS = new Set<LinkReference["landmark"]>(["header", "nav", "footer"]);

/** header (site-wide) > nav > footer > other. Used to pick the strongest landmark when
 * several nav links to one target merge into a single "*" edge. */
function landmarkRank(landmark: LinkReference["landmark"]): number {
  return landmark === "header" ? 3 : landmark === "nav" ? 2 : landmark === "footer" ? 1 : 0;
}

function originsOf(reference: LinkReference): Array<"crawl" | "usage"> {
  return reference.origins || (reference.origin ? [reference.origin] : []);
}

function mergeLink(previous: LinkReference, reference: LinkReference): LinkReference {
  const origins = [...new Set([...originsOf(previous), ...originsOf(reference)])];
  return {
    ...previous,
    // Representative label = the shorter (matches canonicalize); href = the more-observed one.
    label: previous.label.length <= reference.label.length ? previous.label : reference.label,
    href: previous.observations >= reference.observations ? previous.href : reference.href,
    landmark: landmarkRank(previous.landmark) >= landmarkRank(reference.landmark) ? previous.landmark : reference.landmark,
    observations: previous.observations + reference.observations,
    firstSeenAt: previous.firstSeenAt < reference.firstSeenAt ? previous.firstSeenAt : reference.firstSeenAt,
    lastSeenAt: previous.lastSeenAt > reference.lastSeenAt ? previous.lastSeenAt : reference.lastSeenAt,
    ...(origins.length ? { origins, origin: origins[0] } : {}),
  };
}

/**
 * Cluster to one link per key: `(fromSceneId, toSceneId, landmark)` for normal edges, and
 * `(fromSceneId="*", toSceneId)` — landmark-independent — for global nav so a target has a
 * single `"*"` edge. Evidence is merged, never dropped. Deterministic id from the key.
 */
export function clusterLinkReferences(links: LinkReference[], byPair = false): LinkReference[] {
  const clustered = new Map<string, LinkReference>();
  for (const reference of links) {
    const key = reference.fromSceneId === "*"
      ? `*:${reference.toSceneId}`
      : byPair
        ? `${reference.fromSceneId}:${reference.toSceneId}`
        : `${reference.fromSceneId}:${reference.toSceneId}:${reference.landmark}`;
    const previous = clustered.get(key);
    clustered.set(key, previous ? mergeLink(previous, reference) : { ...reference, id: `link_${stableHash(key)}` });
  }
  return [...clustered.values()];
}

/**
 * Replace site-wide navigation with one `fromSceneId:"*"` link per target. A target is global
 * nav when it is linked from a `header` (site-wide immediately) or from `nav`/`footer` on ≥2
 * distinct source scenes — detection uses real nav landmarks only. Once a target IS global nav,
 * EVERY per-source link into it (any landmark — incl. `main`/`unknown` menu links captured with
 * SEO-title labels) is redundant with the single `"*"` edge and is collapsed onto it, since the
 * target is reachable from anywhere. A single-source local nav link to a NON-global target
 * (pagination / date switcher) stays a normal edge. Non-global targets are untouched.
 */
export function collapseGlobalNav(links: LinkReference[]): LinkReference[] {
  const headerTargets = new Set<string>();
  const navSources = new Map<string, Set<string>>();
  for (const link of links) {
    if (link.fromSceneId === "*") { headerTargets.add(link.toSceneId); continue; }
    if (link.landmark === "header") headerTargets.add(link.toSceneId);
    if (NAV_LANDMARKS.has(link.landmark)) {
      const sources = navSources.get(link.toSceneId) ?? new Set<string>();
      sources.add(link.fromSceneId);
      navSources.set(link.toSceneId, sources);
    }
  }
  const globalTargets = new Set<string>(headerTargets);
  for (const [target, sources] of navSources) if (sources.size >= 2) globalTargets.add(target);

  return links.map((link) =>
    link.fromSceneId !== "*" && globalTargets.has(link.toSceneId)
      ? { ...link, fromSceneId: "*" }
      : link,
  );
}

/**
 * Crawl-adoption aggregation: collapse global nav to `"*"`, drop self-loops (`from===to` — the
 * topology ignores them; several are same-page #anchors), then cluster to ONE link per scene
 * PAIR (landmark folded). ~357 per-instance links → ~content scene-pairs + one `"*"` per nav target.
 */
export function aggregateKnowledgeLinks(links: LinkReference[]): LinkReference[] {
  const collapsed = collapseGlobalNav(links).filter((link) => link.fromSceneId !== link.toSceneId);
  return clusterLinkReferences(collapsed, true);
}
