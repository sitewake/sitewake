import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  runtimeFeatureEtag,
  siteAgentRuntimeFeatures,
  siteRolloutEnabled,
} from "../lib/site-knowledge/runtime-features.ts";
import { preserveRuntimeReleaseFeatures } from "../client/user-agent-runtime-release.ts";

function release(runtimeFeatures) {
  return {
    schemaVersion: "site-agent.v2",
    id: "site-a:release:7",
    siteAgentId: "site-a",
    version: 7,
    createdAt: "2026-08-18T00:00:00.000Z",
    contentHash: "release-7",
    profile: { name: "Site A", description: "", vocabulary: {}, suggestedGoals: [] },
    agentConfig: {}, scenes: [], targets: [], operations: [], capabilities: [], outcomes: [],
    evalSummary: { passed: true, evaluatedEpisodes: 0, successfulEpisodes: 0, failedEpisodes: 0, generatedAt: "2026-08-18T00:00:00.000Z" },
    sourceEpisodeIds: [],
    ...(runtimeFeatures ? { runtimeFeatures } : {}),
  };
}

test("runtime rollout flags support off, explicit canaries, and deterministic percentages", () => {
  assert.equal(siteRolloutEnabled(undefined, "site-a"), false);
  assert.equal(siteRolloutEnabled("all", "site-a"), true);
  assert.equal(siteRolloutEnabled("sites:site-a, site-b", "site-b"), true);
  assert.equal(siteRolloutEnabled("sites:site-a, site-b", "site-c"), false);
  assert.equal(siteRolloutEnabled("percent:0", "site-a"), false);
  assert.equal(siteRolloutEnabled("percent:100", "site-a"), true);
  assert.equal(siteRolloutEnabled("percent:17", "site-a"), siteRolloutEnabled("percent:17", "site-a"));
});

test("evidence rollout is subordinate to runtime V2 and flags alter the cache identity", () => {
  const disabledRuntime = siteAgentRuntimeFeatures("site-a", {
    SITEWAKE_PAGE_AGENT_RUNTIME_V2: "off",
    SITEWAKE_PAGE_AGENT_EVIDENCE_V2: "on",
    SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX: "off",
  });
  assert.deepEqual(disabledRuntime, {
    pageAgentRuntimeV2: false,
    pageAgentEvidenceV2: false,
    capabilityExperienceOutbox: false,
  });
  const enabled = siteAgentRuntimeFeatures("site-a", {
    SITEWAKE_PAGE_AGENT_RUNTIME_V2: "sites:site-a",
    SITEWAKE_PAGE_AGENT_EVIDENCE_V2: "sites:site-a",
    SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX: "sites:site-a",
  });
  assert.deepEqual(enabled, {
    pageAgentRuntimeV2: true,
    pageAgentEvidenceV2: true,
    capabilityExperienceOutbox: true,
  });
  assert.notEqual(runtimeFeatureEtag(disabledRuntime), runtimeFeatureEtag(enabled));
});

test("a late same-version connection Release cannot erase runtime evidence flags", () => {
  const enabled = {
    pageAgentRuntimeV2: true,
    pageAgentEvidenceV2: true,
    capabilityExperienceOutbox: true,
  };
  const runtime = release(enabled);
  const connection = release();
  assert.deepEqual(preserveRuntimeReleaseFeatures(runtime, connection).runtimeFeatures, enabled);

  const disabled = {
    pageAgentRuntimeV2: false,
    pageAgentEvidenceV2: false,
    capabilityExperienceOutbox: false,
  };
  assert.deepEqual(
    preserveRuntimeReleaseFeatures(runtime, release(disabled)).runtimeFeatures,
    disabled,
    "an explicit runtime projection remains authoritative and may disable flags",
  );
});

test("the connection boundary returns the same runtime feature projection as the runtime Release", async () => {
  const route = await readFile(new URL("../app/api/site-agents/[siteAgentId]/connection/route.ts", import.meta.url), "utf8");
  assert.match(route, /runtimeFeatures: siteAgentRuntimeFeatures\(siteAgentId\)/);
});

test("rollout flags are read under SITEWAKE_ only; any other prefix is the same as unset", () => {
  const on = siteAgentRuntimeFeatures("site-a", { SITEWAKE_PAGE_AGENT_RUNTIME_V2: "all" });
  assert.equal(on.pageAgentRuntimeV2, true);
  // A product prefix other than the current one is not a fallback, whatever it spells.
  for (const prefix of ["OTHERBRAND", "OLDNAME", "X"]) {
    const off = siteAgentRuntimeFeatures("site-a", { [`${prefix}_PAGE_AGENT_RUNTIME_V2`]: "all" });
    assert.equal(off.pageAgentRuntimeV2, false, prefix);
  }
});
