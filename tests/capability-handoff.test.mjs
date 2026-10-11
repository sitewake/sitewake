import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// These expectations were read off the client's own admission logic before it
// was extracted, so they lock the behaviour rather than describe the new code.
// The extraction only pays off if both sides keep answering identically: the
// effect drawer's whole claim is "what you see is what was handed over", and a
// second copy of these gates would drift without any test noticing.
async function moduleFrom(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { capabilityHandoffForEpisode, CAPABILITY_EXPERIENCE_MAX_BYTES } =
  await moduleFrom("../lib/capability-center-v2/experience.ts");

function page(url, title = "热搜时光机", heading = "热搜") {
  return {
    id: "obs_1", sessionId: "browser_1", documentId: "doc_1", sequence: 1,
    url, title, heading, visibleText: "热搜榜", links: [], elements: [], metadata: {},
    capturedAt: "2026-08-20T04:40:30.672Z",
  };
}

function clickAction(overrides = {}) {
  return {
    action: "click",
    rawAction: "click_element_by_index",
    input: { index: 29 },
    element: { tag: "div", accessibleName: "许家印一审被判无期", landmark: "main" },
    page: { url: "https://www.example.org/", title: "热搜时光机", heading: "热搜" },
    observedAt: "2026-08-20T04:40:36.383Z",
    ...overrides,
  };
}

/** A run that the client would hand over, so each test can spoil one thing. */
function episode(overrides = {}) {
  return {
    schemaVersion: "site-agent.v2",
    id: "episode_9216c74a",
    siteAgentId: "acme-production",
    taskSessionId: "run_76376d42",
    browserSessionId: "browser_b7d0a34e",
    documentId: "doc_1",
    mode: "adaptive",
    goal: "帮我点开今天排第一的热搜，看看它的详情",
    normalizedGoal: "帮我点开今天排第一的热搜 看看它的详情",
    input: {},
    startedAt: "2026-08-20T04:40:30.672Z",
    endedAt: "2026-08-20T04:40:55.498Z",
    releaseId: "acme-production:release:239",
    startSnapshot: page("https://www.example.org/"),
    endSnapshot: page("https://www.example.org/?topic=Wnf0Jg"),
    transitions: [],
    outcome: {
      status: "success",
      code: "agent_completed",
      summary: "已成功打开今天排名第一的热搜。",
      evaluatedAt: "2026-08-20T04:40:55.000Z",
      evidence: {},
    },
    experience: {
      version: 1,
      actions: [clickAction()],
      actorSummary: "已成功打开。",
      judgeEvidence: ["https://www.example.org/?topic=Wnf0Jg", "热搜"],
      toolReceipts: [],
    },
    ...overrides,
  };
}

test("a page-exploration run that reached success is handed over", () => {
  const handoff = capabilityHandoffForEpisode(episode(), {});

  assert.equal(handoff.delivered, true);
  assert.equal(handoff.experience.episodeId, "episode_9216c74a");
  assert.equal(handoff.experience.agentRunId, "run_76376d42");
  assert.equal(handoff.experience.outcome, "Success");
  assert.equal(handoff.experience.actions.length, 1);
});

test("a no-result run is handed over too", () => {
  const handoff = capabilityHandoffForEpisode(
    episode({ outcome: { ...episode().outcome, status: "no-result" } }), {});

  assert.equal(handoff.delivered, true);
  assert.equal(handoff.experience.outcome, "NoResult");
});

test("only the two page fields survive; the snapshots do not travel", () => {
  const handoff = capabilityHandoffForEpisode(episode(), {});

  // 97% of a stored Episode is `elements`/`links`/`visibleText`. None of it is
  // part of the contract with the capability centre.
  assert.deepEqual(Object.keys(handoff.experience.startPage).sort(), ["heading", "title", "url"]);
  assert.equal(handoff.experience.endPage.url, "https://www.example.org/?topic=Wnf0Jg");
});

test("a run that was not page exploration is not handed over", () => {
  // Validation replays and passive observation are not first-hand exploration.
  const handoff = capabilityHandoffForEpisode(episode({ mode: "validation" }), {});

  assert.equal(handoff.delivered, false);
  assert.equal(handoff.reason, "not-adaptive");
});

test("carrying on exploring is still exploring; repairing a capability is not", () => {
  // A second pass of an exploration used to be labelled `repair` with no
  // capability attached, and the handover dropped it: a 490-second success
  // with two page actions reached the capability centre as nothing at all,
  // and the console said only "no intake record".
  const continued = capabilityHandoffForEpisode(episode({ mode: "repair" }), {});
  assert.equal(continued.delivered, true, JSON.stringify(continued));

  // Repairing a published capability names it, and belongs to that
  // capability's own path rather than to discovery.
  const repairing = capabilityHandoffForEpisode(episode({ mode: "repair", sourceCapabilityId: "capability_3ef645c7" }), {});
  assert.equal(repairing.delivered, false);
  assert.equal(repairing.reason, "capability-repair");
});

test("running a published capability is not a discovery", () => {
  const handoff = capabilityHandoffForEpisode(episode({ capabilityId: "capability_3ef645c7" }), {});

  assert.equal(handoff.delivered, false);
  assert.equal(handoff.reason, "capability-call");
});

test("an Episode without experience evidence is not handed over", () => {
  const handoff = capabilityHandoffForEpisode(episode({ experience: undefined }), {});

  assert.equal(handoff.delivered, false);
  assert.equal(handoff.reason, "no-experience-evidence",
    "this is the case the drawer could not tell apart from knowledge navigation");
});

test("a terminal state other than success or no-result is not handed over", () => {
  for (const status of ["execution-fault", "business-rejection", "unknown"]) {
    const handoff = capabilityHandoffForEpisode(
      episode({ outcome: { ...episode().outcome, status } }), {});

    assert.equal(handoff.delivered, false, `${status} must not be handed over`);
    assert.equal(handoff.reason, "outcome-not-eligible");
  }
});

test("actions that never touched the page are not page evidence", () => {
  const handoff = capabilityHandoffForEpisode(
    episode({ experience: { ...episode().experience, actions: [clickAction({ action: "unknown" })] } }), {});

  assert.equal(handoff.delivered, false);
  assert.equal(handoff.reason, "no-page-action");
});

test("an oversized payload is not handed over, and its size is reported", () => {
  const bulky = Array.from({ length: 24 }, () => clickAction({
    element: { tag: "div", accessibleName: "长".repeat(600), contextText: "文".repeat(600), landmark: "main" },
  }));
  const handoff = capabilityHandoffForEpisode(
    episode({ experience: { ...episode().experience, actions: bulky } }),
    { padding: "x".repeat(60_000) });

  assert.equal(handoff.delivered, false);
  assert.equal(handoff.reason, "payload-too-large");
  assert.ok(handoff.bytes > CAPABILITY_EXPERIENCE_MAX_BYTES,
    "the reason is only actionable with the size that broke the limit");
});

test("a malformed Episode is refused rather than thrown out of", () => {
  const handoff = capabilityHandoffForEpisode(episode({ startSnapshot: page("") }), {});

  assert.equal(handoff.delivered, false);
  assert.equal(handoff.reason, "malformed");
});

test("a delivered payload reports its size", () => {
  const handoff = capabilityHandoffForEpisode(episode(), {});

  assert.ok(handoff.bytes > 0 && handoff.bytes <= CAPABILITY_EXPERIENCE_MAX_BYTES);
});

test("a run that clicked before it was interrupted still deposits when the last attempt only scrolled", async () => {
  // The run in production: attempt one clicked and fell over, attempt two
  // scrolled and reached the goal. Judged per attempt, the successful one had
  // no action of its own and the whole run deposited nothing.
  const { readFile } = await import("node:fs/promises");
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  // The run's actions are remembered as each attempt is ingested…
  assert.match(port, /private rememberRunPageActions\(episode: TaskEpisode\)/);
  assert.match(port, /this\.rememberRunPageActions\(episode\);/);
  // …and the handover reads the run, not the attempt.
  assert.match(port, /capabilityHandoffForEpisode\(this\.episodeWithRunEvidence\(episode\), output\)/);
  // A new run never inherits the previous one's doing.
  assert.match(port, /this\.runPageActions\?\.runId !== episode\.taskSessionId/);
});

test("the client submits through the shared function, not its own copy", async () => {
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");

  // A second copy of the admission gates would let the drawer show a payload
  // that would never actually be sent, and nothing else would catch it.
  assert.match(port, /capabilityHandoffForEpisode/,
    "the submission path must call the shared function");
  assert.doesNotMatch(port, /normalizeCapabilityExperience\(\{[\s\S]{0,80}schemaVersion: "1\.0"/,
    "the client must no longer build the payload itself");
});

test("the input generation receives is built here, not rebuilt in the drawer", async () => {
  const { discoveryGenerationInputFromExperience } =
    await moduleFrom("../lib/capability-center-v2/experience.ts");
  const handoff = capabilityHandoffForEpisode(episode(), {});
  const input = discoveryGenerationInputFromExperience(handoff.experience);

  assert.equal(input.source, "Episode");
  assert.equal(input.experience.mode, "adaptive");
  assert.equal(input.request.goal, handoff.experience.originalGoal);
  assert.equal(input.request.entryUrl, handoff.experience.startPage.url);
  assert.equal(input.experience.evidence.actionCount, handoff.experience.actions.length);

  // The restructuring drops fields, and that is exactly what the drawer exists
  // to make visible. Pin the loss so a silent change to the contract is caught.
  const carried = JSON.stringify(input);
  for (const dropped of ["browserSessionId", "startedAt", "endedAt", "schemaVersion"]) {
    assert.ok(!carried.includes(`"${dropped}"`), `${dropped} is not carried into generation`);
  }
  assert.deepEqual(input.request.parameters, {}, "parameter provenance has no channel today");
});

test("the discovery path and the drawer share one construction", async () => {
  const service = await readFile(new URL("../lib/capability-center-v2/experience-service.ts", import.meta.url), "utf8");
  const store = await readFile(new URL("../db/effect-store.ts", import.meta.url), "utf8");

  const discovery = service.slice(
    service.indexOf("export async function createDiscoveryFromExperience"),
    service.indexOf("export async function createCapabilityFromAuthorizedExperience"));
  assert.ok(discovery, "the discovery entry point has to exist");
  assert.match(discovery, /discoveryGenerationInputFromExperience\(experience\)/,
    "generation must consume the shared shape");
  assert.doesNotMatch(discovery, /const input: CapabilityGenerationInput = \{/,
    "a second literal here would drift from what the drawer shows");
  // The repair path deliberately keeps its own shape (mode "repair" plus a
  // capability context); the helper covers discovery only.
  assert.match(service, /mode: "repair"/);
  assert.match(store, /discoveryGenerationInputFromExperience\(handoff\.experience\)/);
});

test("only the agreed contract reaches the drawer", async () => {
  const component = await readFile(new URL("../components/effect-center.tsx", import.meta.url), "utf8");
  const store = await readFile(new URL("../db/effect-store.ts", import.meta.url), "utf8");

  // The drawer shows the one structure both modules agree on. The source
  // Episode and the intermediate handover stay server-side: shipping four
  // payloads made the panel noisy without making the contract clearer.
  assert.match(store, /generationInput: redactJson\(/, "it must be redacted server-side");

  assert.doesNotMatch(store, /experience: redactJson\(/,
    "the intermediate handover is no longer sent to the client");
  assert.doesNotMatch(component, /episode\.experience/,
    "and nothing renders it");
  assert.doesNotMatch(component, /onLoadEpisode/,
    "the on-demand Episode fetch went with the fold that used it");
});

test("a visitor's hand-made demonstration is handed over like an adaptive run", () => {
  // After the agent could not do it, the visitor showed the path by hand. That
  // record used to be dropped as "not-adaptive" and never reached the capability center.
  const handoff = capabilityHandoffForEpisode(episode({ mode: "demonstration" }), {});
  assert.equal(handoff.delivered, true);
  assert.equal(handoff.experience.originalGoal, episode().goal);
});

test("every action kind the rule accepts is one the runtime records", async () => {
  // The rule listed `scroll` and nothing ever wrote a scroll, so a run that
  // reached its goal by scrolling looked like a run that never touched the
  // page: the capability centre was told there was no action evidence, and a
  // 173-second success deposited nothing.
  const { readFile } = await import("node:fs/promises");
  const [protocol, runtime, gate] = await Promise.all([
    readFile(new URL("../lib/site-knowledge/protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/capability-center-v2/experience.ts", import.meta.url), "utf8"),
  ]);
  const declared = /EXPERIENCE_PAGE_ACTIONS[^=]*=\s*\[([^\]]+)\]/.exec(protocol)?.[1] || "";
  const kinds = [...declared.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
  assert.ok(kinds.includes("click") && kinds.includes("scroll"), `kinds: ${kinds.join(",")}`);
  for (const kind of kinds) {
    assert.ok(runtime.includes(`record("${kind}"`), `nothing records a ${kind}, so the rule can never see one`);
  }
  // And the admission gate reads that same list rather than keeping a copy.
  // (The normalizer's list of *valid* action values is a different thing: a
  // payload may carry a wait or an unknown, they just prove nothing.)
  const evidenceFn = /export function capabilityExperienceHasPageEvidence[\s\S]*?\n\}/.exec(gate)?.[0] || "";
  assert.match(evidenceFn, /EXPERIENCE_PAGE_ACTIONS/, "the gate must read the shared list, not keep a copy");
});
