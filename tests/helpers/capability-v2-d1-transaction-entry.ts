import {
  capabilityCandidateHash,
  capabilityValidationSuiteHash,
  canonicalCapabilityCaseJson,
} from "../../lib/capability-center-v2/case-generation";
import {
  claimTask,
  completeC2CaseGeneration,
  createCapabilityTask,
  getCapabilityClassificationReservation,
  listCapabilities,
  listVersions,
  publishValidatedCapability,
  resetCapabilityCenterV2ForTests,
  saveTaskArtifact,
  submitTaskResult,
} from "../../db/capability-center-v2-store";
import { putCapabilityV2Module } from "../../db/capability-center-v2-module-store";
import type { CapabilityCandidate } from "../../lib/capability-center-v2/model";

const source = `export const capability={version:2,stages:[{id:"search",async run({input}){const query=String(input.query??"").trim();return {outcome:"Success",output:{query,resultUrl:"/search?s="+encodeURIComponent(query),heading:query}}}}]};`;

export async function runD1TransactionRollbackFixture(options: { baseVersionId?: string; suffix?: string } = {}) {
  const siteId = "d1_transaction_rollback_fixture";
  resetCapabilityCenterV2ForTests();
  const stored = await putCapabilityV2Module(siteId, source);
  const candidate: CapabilityCandidate = {
    name: "D1 事务回滚搜索" + (options.suffix || ""),
    description: "按 query 搜索并返回结果" + (options.suffix || ""),
    aliases: ["事务回滚搜索"],
    contract: {
      intent: "按 query 搜索商品",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", minLength: 1 } },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          resultUrl: { type: "string" },
          heading: { type: "string" },
        },
        required: ["query", "resultUrl", "heading"],
        additionalProperties: false,
      },
      preconditions: [{ type: "inputExists", path: "query" }],
      successConditions: [{ type: "urlTemplate", template: "/search?s={{query}}" }, { type: "outputExists", path: "heading" }],
      scope: { kind: "site-global", onMismatch: "no-match" },
    },
    program: {
      schemaVersion: "2.0",
      runtime: "BrowserJavaScriptStage",
      module: stored.module,
      entry: { mode: "CurrentPage" },
      stages: [{
        id: "search",
        title: "Search",
        purpose: "按 query 返回搜索结果",
        effect: "read",
        resumePolicy: "skip-completed",
        io: { reads: { input: ["query"], state: [] }, writes: { state: [], output: ["query", "resultUrl", "heading"] } },
        navigation: "none",
      }],
      parameterRoles: [{ inputPath: "query", role: "target" }],
      targetBindings: [{ inputPath: "query", targetKind: "search-query", identityStatePath: "query", required: true }],
      promptProvenance: [],
    },
  };
  const task = (await createCapabilityTask(siteId, {
    type: "Discovery",
    goal: candidate.description,
    guidance: "D1 transaction rollback fixture",
    input: {
      parameters: { query: "notebook" },
      context: { startUrl: "http://example.test/", __pipelineVersion: "2.0" },
      candidateSummary: candidate,
      program: candidate.program,
      interactions: [],
      trigger: options.baseVersionId ? { baseVersionId: options.baseVersionId } : {},
    },
  })).task;
  await claimTask(siteId, task.id, "d1-rollback-runner");
  const suite = {
    cases: [
      { caseId: "case_1", input: { query: "notebook" }, expected: { query: "notebook" } },
      { caseId: "case_2", input: { query: "mug" }, expected: { query: "mug" } },
    ],
  };
  const evidence = {
    schemaVersion: "1.0",
    generationTaskId: task.id,
    siteId,
    candidateHash: capabilityCandidateHash(candidate),
    explorationMode: "read-only-interactive",
    regions: [
      { regionId: "region_notebook", url: "http://example.test/", kind: "business-region", text: "notebook", observedValues: ["notebook"] },
      { regionId: "region_mug", url: "http://example.test/", kind: "business-region", text: "mug", observedValues: ["mug"] },
    ],
    actions: [{ action: "inspect", outcome: "performed", url: "http://example.test/", reason: "fixture", requestMethod: "GET" }],
    cases: suite.cases.map((testCase) => ({
      caseId: testCase.caseId,
      parameters: [{ inputPath: "query", regionId: `region_${testCase.input.query}`, observedValue: testCase.input.query }],
    })),
  };
  const evidenceBytes = new TextEncoder().encode(canonicalCapabilityCaseJson(evidence));
  const savedEvidence = await saveTaskArtifact(siteId, task.id, { kind: "CaseDiscoveryEvidence", contentType: "application/json", bytes: evidenceBytes });
  const c2Output = {
    generationTaskId: task.id,
    candidate,
    validationSuite: suite,
    caseDiscoveryEvidenceRef: {
      artifactRef: `artifact://${savedEvidence.artifact.id}`,
      contentHash: `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", evidenceBytes)).toString("hex")}`,
      byteLength: evidenceBytes.byteLength,
    },
    validationSuiteHash: capabilityValidationSuiteHash(suite),
  };
  const committed = await completeC2CaseGeneration(siteId, task, c2Output);
  const validationTask = (await claimTask(siteId, committed.validationTask.id, "d1-c3-runner")).task;
  const submitted = await submitTaskResult(siteId, validationTask.id, "d1-c3-runner", {
    outcome: "Success",
    validationResults: suite.cases.map((testCase) => ({
      caseId: testCase.caseId,
      resolvedInput: testCase.input,
      output: { query: testCase.input.query, resultUrl: `/search?s=${testCase.input.query}`, heading: testCase.input.query },
      stageReceipts: [{ stageId: "search", outcome: "Success", evidenceRefs: [`evidence://${testCase.caseId}`] }],
      evidenceRefs: [`evidence://${testCase.caseId}`],
    })),
  });
  const validated = submitted.task.result?.buildResult?.outcome === "Validated" ? submitted.task.result.buildResult.package : undefined;
  if (!validated) throw new Error("d1_rollback_fixture_validation_missing");
  const published = await publishValidatedCapability(siteId, {
    generationTaskId: task.id,
    validated,
    authorization: { mode: "AdminOverride", adminId: "d1-fixture", reason: "测试事务回滚" },
  });
  return {
    published,
    capabilities: (await listCapabilities(siteId)).capabilities,
    versions: (await listVersions(siteId, published.outcome === "Published" ? published.capability.id : "missing")).versions,
    reservation: await getCapabilityClassificationReservation(siteId, task.id),
    candidateArtifactId: committed.artifact.candidateId,
    validationTaskId: committed.validationTask.id,
  };
}
