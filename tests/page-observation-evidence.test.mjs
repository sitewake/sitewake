import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function bundledModule(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

function runFixture(overrides = {}) {
  const { agentState: agentStateOverride = {}, ...rest } = overrides;
  return {
    id: "run-evidence",
    controller: "page-agent",
    scope: { kind: "site", siteAgentId: "site-evidence", allowedOrigins: ["https://shop.test"], knowledgeNamespaceIds: [] },
    status: "running",
    goal: "search for cushion",
    input: { query: "cushion" },
    conversation: [],
    agentState: {
      runtimeModelBudget: {
        requestCount: 1,
        stageCounts: { "runtime-page-agent": 1, "runtime-boundary": 0 },
      },
      ...agentStateOverride,
    },
    activityTimeline: [],
    bindings: {},
    activePort: {
      id: "port", documentId: "document-1", browserSessionId: "browser-1", origin: "https://shop.test",
      url: "https://shop.test/", pageEpoch: 1, claimedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 10_000).toISOString(), state: "active",
    },
    pageEpoch: 1,
    eventSequence: 1,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...rest,
  };
}

async function observation(hashModule, overrides = {}) {
  const {
    capturedAt: capturedOverride,
    expiresAt: expiresOverride,
    content,
    state,
    ...rest
  } = overrides;
  const capturedAt = capturedOverride || new Date().toISOString();
  const value = {
    schemaVersion: "page-agent-observation.v1",
    id: overrides.id || "observation-1",
    siteAgentId: "site-evidence",
    runId: "run-evidence",
    episodeId: "episode-evidence",
    browserSessionId: "browser-1",
    documentId: rest.documentId || "document-1",
    pageEpoch: rest.pageEpoch || 1,
    turnIndex: rest.turnIndex ?? 0,
    kind: rest.kind || "full",
    ...(rest.baseObservationId ? { baseObservationId: rest.baseObservationId } : {}),
    state: state || { url: "https://shop.test/products", title: "Products", header: "Shop", content: content || "Product A", footer: "" },
    targets: [],
    sha256: "0".repeat(64),
    producer: { controller: "@page-agent/page-controller", controllerVersion: "1.0.0", projection: "user-agent-adaptive", projectionVersion: 1 },
    capturedAt,
    // capturedAt+14d is intentionally milliseconds behind arrival.
    expiresAt: expiresOverride || new Date(Date.parse(capturedAt) + 14 * 86_400_000).toISOString(),
    ...rest,
  };
  value.sha256 = await hashModule.pageObservationSha256(value);
  return value;
}

test("observation hash is canonical and rejects evidence tampering", async () => {
  const hashes = await bundledModule("../lib/capability-center-v2/page-observation.ts");
  const first = await observation(hashes);
  const reordered = {
    ...first,
    state: { content: first.state.content, footer: first.state.footer, title: first.state.title, url: first.state.url, header: first.state.header },
  };
  assert.equal(await hashes.pageObservationSha256(reordered), first.sha256);
  assert.notEqual(await hashes.pageObservationSha256({ ...first, state: { ...first.state, content: "tampered" } }), first.sha256);
  assert.equal(await hashes.pageObservationSha256({ ...first, expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() }), first.sha256);
});

test("observation hash does not require Web Crypto and matches SHA-256 vectors", async () => {
  const hashes = await bundledModule("../lib/site-knowledge/sha256.ts");
  assert.equal(
    hashes.sha256HexText("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) } });
  try {
    assert.equal(hashes.sha256HexText("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  } finally {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
  }
});

test("schema-aware Episode sanitization preserves identity while redacting content", async () => {
  const sensitive = await bundledModule("../lib/site-knowledge/sensitive-data.ts");
  const snapshot = {
    id: "snapshot-1", sessionId: "run_123", documentId: "document_123", sequence: 1,
    url: "https://shop.test/checkout?token=secret", title: "Checkout", heading: "Payment",
    visibleText: "card number 4111 1111 1111 1111 cvc: 123", links: [], capturedAt: new Date().toISOString(),
  };
  const episode = {
    schemaVersion: "2.0", id: "episode_123", siteAgentId: "site_123", taskSessionId: "run_123",
    browserSessionId: "browser_123", documentId: "document_123", mode: "adaptive",
    goal: "use card 4111 1111 1111 1111 cvc: 123", normalizedGoal: "use card 4111 1111 1111 1111 cvc: 123",
    input: { arbitrary: "4111 1111 1111 1111", sessionId: "secret-session" },
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), startSnapshot: snapshot, endSnapshot: snapshot,
    transitions: [], outcome: { status: "unknown", code: "stopped", summary: "cvc: 123", evaluatedAt: new Date().toISOString(), evidence: {} },
  };
  const clean = sensitive.sanitizeTaskEpisode(episode);
  assert.equal(clean.id, episode.id);
  assert.equal(clean.taskSessionId, episode.taskSessionId);
  assert.equal(clean.browserSessionId, episode.browserSessionId);
  assert.equal(clean.documentId, episode.documentId);
  assert.doesNotMatch(JSON.stringify(clean), /4111 1111 1111 1111|cvc:\s*123|secret-session/iu);
  assert.match(JSON.stringify(clean), /\[REDACTED\]/u);
});

test("memory observation store enforces bounds, authority, idempotency and page epochs", async () => {
  const [hashes, store] = await Promise.all([
    bundledModule("../lib/capability-center-v2/page-observation.ts"),
    bundledModule("../db/page-observation-store.ts"),
  ]);
  store.resetMemoryPageObservationStore();
  const run = runFixture();
  const first = await observation(hashes);
  const accepted = await store.appendPageAgentObservations(run, [first]);
  assert.equal(accepted.accepted, 1);
  const duplicate = await store.appendPageAgentObservations(run, [first]);
  assert.equal(duplicate.duplicates, 1);
  const conflict = { ...first, sha256: "f".repeat(64) };
  await assert.rejects(store.appendPageAgentObservations(run, [conflict]), /hash_mismatch|conflict/);

  const nextRun = {
    ...run,
    pageEpoch: 2,
    activePort: { ...run.activePort, pageEpoch: 2, documentId: "document-2", url: "https://shop.test/products?page=2" },
  };
  const sameTurnNewPage = await observation(hashes, { id: "observation-epoch-2", pageEpoch: 2, documentId: "document-2", turnIndex: 0 });
  assert.equal((await store.appendPageAgentObservations(nextRun, [sameTurnNewPage])).accepted, 1);
  for (const [patch, message] of [
    [{ id: "wrong-site", siteAgentId: "other", pageEpoch: 2, documentId: "document-2" }, /authority_rejected/],
    [{ id: "wrong-run", runId: "other", pageEpoch: 2, documentId: "document-2" }, /authority_rejected/],
    [{ id: "wrong-document", pageEpoch: 2, documentId: "other" }, /authority_rejected/],
    [{ id: "wrong-origin", pageEpoch: 2, documentId: "document-2", state: { ...first.state, url: "https://evil.test/" } }, /authority_rejected/],
  ]) {
    const forged = await observation(hashes, patch);
    await assert.rejects(store.appendPageAgentObservations(nextRun, [forged]), message);
  }
  const sensitive = await observation(hashes, {
    id: "sensitive", pageEpoch: 2, documentId: "document-2", turnIndex: 1,
    state: { url: "https://shop.test/products?token=raw", title: "Products", header: "", content: "card number 4111 1111 1111 1111 cvc: 123 password=hunter2", footer: "" },
  });
  await assert.rejects(store.appendPageAgentObservations(nextRun, [sensitive]), /sensitive_data/);
  const sensitiveControl = await observation(hashes, {
    id: "sensitive-control", pageEpoch: 2, documentId: "document-2", turnIndex: 1,
    state: {
      url: "https://shop.test/checkout", title: "Checkout", header: "",
      content: '<input type="password" value="hunter2"><textarea autocomplete="one-time-code">123456</textarea>',
      footer: "",
    },
  });
  await assert.rejects(store.appendPageAgentObservations(nextRun, [sensitiveControl]), /sensitive_data/);
  const tooLarge = await observation(hashes, { id: "too-large", content: "x".repeat(100 * 1024), pageEpoch: 2, documentId: "document-2", turnIndex: 1 });
  await assert.rejects(store.appendPageAgentObservations(nextRun, [tooLarge]), /too_large/);
  const five = await Promise.all(Array.from({ length: 5 }, (_, index) => observation(hashes, { id: `batch-${index}`, pageEpoch: 2, documentId: "document-2", turnIndex: index + 1 })));
  await assert.rejects(store.appendPageAgentObservations(nextRun, five), /batch_invalid/);

  for (let index = 1; index < 10; index += 1) {
    const item = await observation(hashes, { id: `run-limit-${index}`, pageEpoch: 2, documentId: "document-2", turnIndex: index });
    await store.appendPageAgentObservations(nextRun, [item]);
  }
  const twelfth = await observation(hashes, { id: "run-limit-twelve", pageEpoch: 2, documentId: "document-2", turnIndex: 10 });
  await assert.rejects(store.appendPageAgentObservations(nextRun, [twelfth]), /run_limit/);

  const stored = await store.getPageAgentObservations(run.id, { includeExpired: true });
  assert.ok(Date.parse(stored[0].expiresAt) >= Date.now() + 14 * 86_400_000 - 1_000, "server normalizes the 14-day floor at ingestion");
  await store.extendPageAgentObservationRetention(run.id, "episode-evidence", new Date(Date.now() + 90 * 86_400_000).toISOString());
  const extended = await store.getPageAgentObservations(run.id, { includeExpired: true });
  assert.ok(Date.parse(extended[0].expiresAt) >= Date.now() + 90 * 86_400_000 - 1_000);
  const purged = await store.purgeExpiredPageAgentObservations(new Date(Date.now() + 91 * 86_400_000).toISOString());
  assert.equal(purged.purged, 11);
  assert.deepEqual(await store.getPageAgentObservations(run.id, { includeExpired: true }), []);
});

test("strict authority accepts closed create/strengthen chains and rejects partial evidence", async () => {
  const [hashes, authorityModule] = await Promise.all([
    bundledModule("../lib/capability-center-v2/page-observation.ts"),
    bundledModule("../lib/capability-center-v2/experience-authority.ts"),
  ]);
  const before = await observation(hashes, {
    content: "Search form",
    targets: [{ observationId: "observation-1", index: 1, semanticId: "search", role: "button", accessibleName: "Search" }],
  });
  const after = await observation(hashes, {
    id: "observation-2", turnIndex: 1, kind: "delta", baseObservationId: before.id,
    content: "Search results: 1 result for cushion",
    targets: [{ observationId: "observation-2", index: 2, semanticId: "product-cushion", role: "link", accessibleName: "Cushion product" }],
  });
  const refs = [before, after].map((item) => ({ id: item.id, pageEpoch: item.pageEpoch, documentId: item.documentId, turnIndex: item.turnIndex, kind: item.kind, sha256: item.sha256 }));
  const receipt = { id: "receipt-1", turnIndex: 0, action: "click", target: before.targets[0], input: { query: "cushion" }, beforeObservationId: before.id, afterObservationId: after.id, dispatched: true, effect: "changed", effectSignals: {}, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
  const snapshot = (item) => ({ url: item.state.url, title: item.state.title, documentId: item.documentId });
  const baseEpisode = {
    id: "episode-evidence", siteAgentId: "site-evidence", taskSessionId: "run-evidence", browserSessionId: "browser-1",
    documentId: before.documentId, mode: "adaptive", goal: "search for cushion", normalizedGoal: "search for cushion",
    input: { query: "cushion" }, startSnapshot: snapshot(before), endSnapshot: snapshot(after),
    pageExecutionBrief: {
      objective: "search for cushion", normalizedGoal: "search for cushion", entities: { query: "cushion" }, effect: "read",
      completionCriteria: ["Complete the user's original objective: search for cushion", "Observe the page state after the requested page action."],
      relevantSceneIds: [], relevantCapabilityIds: [], rejectedCapabilityReasons: [], knowledgeReceiptRefs: [],
    },
    outcome: { status: "success" },
    experience: {
      observationRefs: refs, actionReceiptsV2: [receipt],
      budgetEvidence: { activeLimitMs: 180_000, modelRequestLimit: 10, activeElapsedMs: 1_000, modelRequests: 1, noProgressCount: 0 },
    },
  };
  assert.equal(authorityModule.capabilityExperienceAuthority(runFixture(), baseEpisode, [before, after])?.kind, "create");
  const humanAfter = await observation(hashes, {
    id: "observation-human-success", turnIndex: 1, kind: "delta", baseObservationId: before.id,
    content: "Product page loaded",
  });
  const humanRefs = [before, humanAfter].map((item) => ({ id: item.id, pageEpoch: item.pageEpoch, documentId: item.documentId, turnIndex: item.turnIndex, kind: item.kind, sha256: item.sha256 }));
  const humanConfirmed = {
    ...baseEpisode,
    endSnapshot: snapshot(humanAfter),
    outcome: { status: "success", evidence: { humanConfirmation: { answer: "success", confirmedAt: new Date().toISOString() } } },
    experience: {
      ...baseEpisode.experience,
      observationRefs: humanRefs,
      actionReceiptsV2: [{ ...receipt, afterObservationId: humanAfter.id }],
    },
  };
  // The terminal page deliberately omits both the query term and a result
  // count.  Human success is still allowed to hand the structurally valid
  // experience to generation; later abstraction/validation owns trust.
  assert.equal(authorityModule.humanConfirmedSuccessAdmission(humanConfirmed, { kind: "required" }), true);
  assert.equal(authorityModule.capabilityExperienceAuthority(runFixture(), humanConfirmed, [before, humanAfter])?.kind, "create");
  assert.equal(authorityModule.capabilityExperienceAuthority(runFixture(), {
    ...humanConfirmed,
    outcome: { ...humanConfirmed.outcome, evidence: { ...humanConfirmed.outcome.evidence, executionIntent: "reconciliation" } },
  }, [before, humanAfter]), undefined);
  const repair = { ...baseEpisode, mode: "repair", sourceCapabilityId: "capability-source", capabilityId: "capability-source", repairKind: "compiled-capability-drift" };
  const repairRun = runFixture({ agentState: { compiledRepairSourceCapabilityId: "capability-source", compiledRepairSourceVersionId: "version-source" } });
  const strengthened = authorityModule.capabilityExperienceAuthority(repairRun, repair, [before, after]);
  assert.equal(strengthened?.kind, "strengthen");
  assert.equal(strengthened?.sourceCapabilityId, "capability-source");
  assert.equal(strengthened?.sourceVersionId, "version-source");
  assert.equal(authorityModule.capabilityExperienceAuthority(runFixture(), { ...baseEpisode, experience: { ...baseEpisode.experience, actionReceiptsV2: [{ ...receipt, afterObservationId: undefined }] } }, [before, after]), undefined);
  assert.equal(authorityModule.capabilityExperienceAuthority(runFixture(), { ...baseEpisode, experience: { ...baseEpisode.experience, actionReceiptsV2: [{ ...receipt, effect: "unchanged" }] } }, [before, after]), undefined);
  const unchangedAfter = await observation(hashes, { id: "observation-unchanged", turnIndex: 1, kind: "delta", baseObservationId: before.id, targets: before.targets.map((target) => ({ ...target, observationId: "observation-unchanged" })) });
  const unchangedRefs = [before, unchangedAfter].map((item) => ({ id: item.id, pageEpoch: item.pageEpoch, documentId: item.documentId, turnIndex: item.turnIndex, kind: item.kind, sha256: item.sha256 }));
  const forgedChanged = { ...baseEpisode, experience: { ...baseEpisode.experience, observationRefs: unchangedRefs, actionReceiptsV2: [{ ...receipt, afterObservationId: unchangedAfter.id, effect: "changed" }] } };
  assert.equal(authorityModule.capabilityExperienceAuthority(runFixture(), forgedChanged, [before, unchangedAfter]), undefined);
  assert.equal(authorityModule.capabilityExperienceAuthority(runFixture(), { ...baseEpisode, experience: { ...baseEpisode.experience, actionReceiptsV2: [{ ...receipt, target: { ...receipt.target, semanticId: "forged-target" } }] } }, [before, after]), undefined);
  assert.equal(authorityModule.capabilityExperienceAuthority(runFixture(), { ...baseEpisode, experience: { ...baseEpisode.experience, actionReceiptsV2: [{ ...receipt, action: "press", effect: "unknown" }] } }, [before, after]), undefined);
  assert.equal(authorityModule.capabilityExperienceAuthority(runFixture(), { ...baseEpisode, experience: { ...baseEpisode.experience, actionReceiptsV2: [{ ...receipt, action: "press", effect: "changed" }] } }, [before, after]), undefined);
  assert.equal(authorityModule.capabilityExperienceAuthority(repairRun, { ...baseEpisode, mode: "repair", repairKind: undefined, sourceCapabilityId: "capability-source" }, [before, after]), undefined);
  assert.equal(authorityModule.capabilityExperienceAuthority(runFixture(), { ...baseEpisode, input: { query: "other" } }, [before, after]), undefined);
  assert.equal(authorityModule.capabilityExperienceAuthority(runFixture({ agentState: { runtimeModelBudget: { requestCount: 2 } } }), baseEpisode, [before, after]), undefined);
  for (const budgetEvidence of [
    { ...baseEpisode.experience.budgetEvidence, exhaustedReason: "active-time" },
    { ...baseEpisode.experience.budgetEvidence, exhaustedReason: "model-requests" },
    { ...baseEpisode.experience.budgetEvidence, exhaustedReason: "no-progress", noProgressCount: 3 },
    { ...baseEpisode.experience.budgetEvidence, activeElapsedMs: baseEpisode.experience.budgetEvidence.activeLimitMs },
  ]) {
    assert.equal(
      authorityModule.capabilityExperienceAuthority(runFixture(), {
        ...baseEpisode,
        experience: { ...baseEpisode.experience, budgetEvidence },
      }, [before, after]),
      undefined,
      "terminal budget exhaustion must never authorize capability learning",
    );
  }
  const tenthModelResponse = {
    ...baseEpisode,
    experience: {
      ...baseEpisode.experience,
      budgetEvidence: { ...baseEpisode.experience.budgetEvidence, modelRequests: 10 },
    },
  };
  assert.equal(
    authorityModule.capabilityExperienceAuthority(
      runFixture({ agentState: { runtimeModelBudget: { requestCount: 10, stageCounts: { "runtime-page-agent": 10 } } } }),
      tenthModelResponse,
      [before, after],
    )?.kind,
    "create",
    "the successful tenth model response remains eligible before an eleventh request is attempted",
  );
  const mixedGoal = "search for alice then follow them";
  const mixedRun = runFixture({ goal: mixedGoal, input: { query: "alice" } });
  const mixedEpisode = {
    ...baseEpisode,
    goal: mixedGoal,
    normalizedGoal: mixedGoal,
    input: { query: "alice" },
    pageExecutionBrief: {
      ...baseEpisode.pageExecutionBrief,
      objective: mixedGoal,
      normalizedGoal: mixedGoal,
      entities: { query: "alice" },
      effect: "reversible-write",
      completionCriteria: [
        `Complete the user's original objective: ${mixedGoal}`,
        "Observe a page or business receipt that proves the requested change took effect.",
      ],
    },
  };
  assert.equal(authorityModule.capabilityExperienceAuthority(mixedRun, mixedEpisode, [before, after]), undefined);

  const staleCartBefore = await observation(hashes, {
    id: "cart-before",
    content: "Mug was added to cart. Cart has 1 item.",
    targets: [{ observationId: "cart-before", index: 1, semanticId: "add-mug", role: "button", accessibleName: "Add Mug to cart" }],
  });
  const staleCartAfter = await observation(hashes, {
    id: "cart-after", turnIndex: 1, kind: "delta", baseObservationId: staleCartBefore.id,
    content: "Mug was added to cart. Cart has 1 item. Recommendations panel opened.",
    targets: [{ observationId: "cart-after", index: 1, semanticId: "add-mug", role: "button", accessibleName: "Add Mug to cart" }],
  });
  const staleCartRefs = [staleCartBefore, staleCartAfter].map((item) => ({
    id: item.id, pageEpoch: item.pageEpoch, documentId: item.documentId,
    turnIndex: item.turnIndex, kind: item.kind, sha256: item.sha256,
  }));
  const cartRun = runFixture({ goal: "add Mug to cart", input: { product: "Mug" } });
  const staleCartEpisode = {
    ...baseEpisode,
    goal: "add Mug to cart",
    normalizedGoal: "add mug to cart",
    input: { product: "Mug" },
    startSnapshot: snapshot(staleCartBefore),
    endSnapshot: snapshot(staleCartAfter),
    pageExecutionBrief: {
      ...baseEpisode.pageExecutionBrief,
      objective: "add Mug to cart",
      normalizedGoal: "add mug to cart",
      entities: { product: "Mug" },
      effect: "reversible-write",
      completionCriteria: [
        "Complete the user's original objective: add Mug to cart",
        "Observe a page or business receipt that proves the requested change took effect.",
      ],
    },
    experience: {
      ...baseEpisode.experience,
      observationRefs: staleCartRefs,
      actionReceiptsV2: [{
        ...receipt,
        target: staleCartBefore.targets[0],
        input: { product: "Mug" },
        beforeObservationId: staleCartBefore.id,
        afterObservationId: staleCartAfter.id,
      }],
    },
  };
  assert.equal(
    authorityModule.capabilityExperienceAuthority(cartRun, staleCartEpisode, [staleCartBefore, staleCartAfter]),
    undefined,
    "a stale added-to-cart banner plus an unrelated DOM change must not authorize learning",
  );
});
