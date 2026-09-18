import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Bundle a pure TS lib module and import it (no D1 / worker bindings needed). */
async function loadModule(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { aggregateKnowledgeLinks } = await loadModule("../lib/site-knowledge/link-aggregation.ts");
const { buildBusinessTopologyFromParts } = await loadModule("../lib/site-knowledge/business-topology.ts");

let seq = 0;
function link(from, to, landmark, over = {}) {
  seq += 1;
  return {
    id: `raw_${seq}`, fromSceneId: from, toSceneId: to, landmark,
    label: over.label ?? `label-${seq}`, href: over.href ?? `/${to}/${seq}`,
    observations: over.observations ?? 1, origin: "crawl", origins: ["crawl"],
    firstSeenAt: over.firstSeenAt ?? "2026-01-01T00:00:00.000Z",
    lastSeenAt: over.lastSeenAt ?? "2026-01-02T00:00:00.000Z",
  };
}
const pairs = (links) => links.map((l) => `${l.fromSceneId}>${l.toSceneId}`).sort();

test("link-aggregation: content links dedupe to one edge per scene-pair (landmark folded)", () => {
  const out = aggregateKnowledgeLinks([
    link("s1", "s2", "main", { label: "AAAA", observations: 2 }),
    link("s1", "s2", "main", { label: "A", observations: 3 }),
    link("s1", "s2", "aside", { observations: 1 }),
  ]);
  assert.equal(out.length, 1, "one edge per (from,to) regardless of landmark");
  assert.equal(out[0].fromSceneId, "s1");
  assert.equal(out[0].observations, 6, "evidence summed across landmarks");
  assert.equal(out[0].label, "A", "keeps the shorter representative label");
});

test("link-aggregation: shared nav (>=2 sources) collapses to one '*' link per target", () => {
  const out = aggregateKnowledgeLinks([
    link("s1", "navT", "nav"),
    link("s2", "navT", "nav"),
    link("s3", "navT", "nav"),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].fromSceneId, "*");
  assert.equal(out[0].toSceneId, "navT");
  assert.equal(out[0].observations, 3, "evidence summed across the collapsed sources");
});

test("link-aggregation: a header link is global immediately (single source)", () => {
  const out = aggregateKnowledgeLinks([link("s1", "navT", "header")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].fromSceneId, "*");
});

test("link-aggregation: single-source local nav to a non-global target is NOT globalized", () => {
  const out = aggregateKnowledgeLinks([link("s1", "s2", "nav")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].fromSceneId, "s1", "one nav source, no header -> stays a normal edge");
});

test("link-aggregation: ALL links to a global-nav target fold into its '*' edge", () => {
  const out = aggregateKnowledgeLinks([
    link("s1", "t", "nav"), link("s2", "t", "nav"), // shared nav -> t is global
    link("s3", "t", "main"),                          // in-content link to a nav target
    link("s4", "t", "unknown"),                        // SEO-title menu link
  ]);
  assert.deepEqual(pairs(out), ["*>t"], "content/unknown links to a nav target fold into the single '*' edge");
});

test("link-aggregation: self-loops (from===to) are dropped", () => {
  const out = aggregateKnowledgeLinks([
    link("s1", "s1", "main", { label: "同页锚点" }),
    link("s1", "s2", "main"),
  ]);
  assert.deepEqual(pairs(out), ["s1>s2"]);
});

test("link-aggregation: topology accepts a '*' link and renders it from site-root", () => {
  const scenes = [
    { id: "home", name: "首页", path: "/", urlTemplates: [{ pathnamePattern: "/", query: {}, originPattern: "*" }], parameters: [], directEntry: "verified", evidenceStatus: "entry-verified", lifecycle: "entry-verified", evidenceCount: 1 },
    { id: "navT", name: "词云", path: "/wordcloud", urlTemplates: [{ pathnamePattern: "/wordcloud", query: {}, originPattern: "*" }], parameters: [], directEntry: "verified", evidenceStatus: "entry-verified", lifecycle: "entry-verified", evidenceCount: 1 },
  ];
  const topology = buildBusinessTopologyFromParts({
    rootName: "站点", scenes,
    linkReferences: [link("*", "navT", "nav")],
    operations: [],
  });
  const toNavT = [...topology.primaryEdges, ...topology.secondaryEdges].filter((edge) => edge.to === "navT");
  assert.ok(toNavT.some((edge) => edge.from === "site-root"), "the '*' nav link renders as site-root -> target");
  assert.ok(!toNavT.some((edge) => edge.from === "*"), "'*' is never a literal node id in an edge");
});
