import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
let sequence = 0;

async function fixture() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-publication-${++sequence}` },
  });
  const database = await miniflare.getD1Database("DB");
  const key = `__CAPABILITY_PUBLICATION_D1_${sequence}`;
  globalThis[key] = database;
  const result = await build({
    stdin: {
      contents: `export * from "./db/capability-center-store.ts"; export { createSiteAgent, getActiveSiteAgentRelease } from "./db/site-agent-store.ts";`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "publication-d1",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
          contents: `const database=globalThis[${JSON.stringify(key)}]; export function getD1Binding(){return database;} export function getArtifactBinding(){return null;} export class D1UnavailableError extends Error {}`,
          loader: "ts",
        }));
      },
    }],
  });
  const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  return { api, database, dispose: async () => { delete globalThis[key]; await miniflare.dispose(); } };
}

function contract(name) {
  return {
    name,
    description: "Read a verified result.",
    goalTemplate: name,
    kind: "task",
    structure: "atomic",
    operation: "read",
    exposure: "public",
    resultKind: "data",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  };
}

test("D1 approval, unpublish, relist and delete switch the runtime Release with the four tables", async () => {
  const { api, database, dispose } = await fixture();
  try {
    const siteAgentId = "publication-d1";
    await api.createSiteAgent({ id: siteAgentId, name: "Publication", url: "https://publication.test/" });
    const created = await api.createCapabilityTask(siteAgentId, {
      type: "generate",
      capability: contract("Read publication"),
      implementation: { kind: "program", moduleRef: { contentHash: "c".repeat(64), moduleUrl: "/programs/publication.js", exportName: "capability" } },
      validation: { status: "passed", runId: "run-publication", startUrl: "https://publication.test/", validatedContentHash: "c".repeat(64) },
    });
    await api.updateCapabilityTaskProgress(siteAgentId, created.task.id, { status: "awaiting-review", stage: "review" });
    await api.actOnCapabilityTask(siteAgentId, created.task.id, "approve");

    const publishedRelease = (await api.getActiveSiteAgentRelease(siteAgentId)).release;
    assert.equal(publishedRelease.capabilities.some((item) => item.id === created.capability.id), true);
    const version = (await api.listCapabilityVersions(siteAgentId, created.capability.id))[0];
    assert.equal(version.publishedReleaseId, publishedRelease.id);
    assert.equal(version.publishedReleaseVersion, publishedRelease.version);
    assert.equal((await api.getCapabilityTask(siteAgentId, created.task.id)).status, "completed");

    await api.actOnCapability(siteAgentId, created.capability.id, "unpublish");
    assert.equal((await api.getActiveSiteAgentRelease(siteAgentId)).release.capabilities.some((item) => item.id === created.capability.id), false);
    await api.actOnCapability(siteAgentId, created.capability.id, "relist");
    assert.equal((await api.getActiveSiteAgentRelease(siteAgentId)).release.capabilities.some((item) => item.id === created.capability.id), true);
    await api.actOnCapability(siteAgentId, created.capability.id, "delete");
    assert.equal((await api.getActiveSiteAgentRelease(siteAgentId)).release.capabilities.some((item) => item.id === created.capability.id), false);
    assert.equal((await database.prepare("SELECT status FROM site_agent_v2_capabilities WHERE id=?").bind(created.capability.id).first()).status, "deleted");
  } finally { await dispose(); }
});

test("D1 task detail joins screenshots, recordings and trace files by Task id", async () => {
  const { api, database, dispose } = await fixture();
  try {
    const siteAgentId = "task-evidence-d1";
    await api.createSiteAgent({ id: siteAgentId, name: "Evidence", url: "https://evidence.test/" });
    const created = await api.createCapabilityTask(siteAgentId, {
      type: "generate",
      capability: {
        ...contract("Open order history"),
        localizedNames: { zhCN: "打开订单历史", en: "Open Order History" },
      },
    });
    const now = "2026-08-02T00:00:00.000Z";
    const artifacts = [
      ["artifact-shot", "screenshot", "结果截图", "image/png"],
      ["artifact-video", "video", "验证录屏", "video/webm"],
      ["artifact-trace", "trace", "浏览器 Trace", "application/zip"],
    ].map(([id, kind, label, contentType]) => ({
      id,
      siteAgentId,
      learningJobId: created.task.id,
      runId: "run-evidence",
      kind,
      label,
      contentType,
      size: 128,
      url: `/api/artifacts/${id}`,
      createdAt: now,
    }));
    for (const artifact of artifacts) {
      await database.prepare(`INSERT INTO site_agent_v2_artifacts
        (id,site_agent_id,learning_job_id,run_id,kind,object_key,artifact_json,created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .bind(artifact.id, siteAgentId, created.task.id, artifact.runId, artifact.kind, `d1:${artifact.id}`, JSON.stringify(artifact), now)
        .run();
    }

    const detail = await api.getCapabilityTaskDetail(siteAgentId, created.task.id);
    assert.deepEqual(detail.artifacts.map((item) => item.kind), ["screenshot", "video", "trace"]);
    assert.deepEqual(detail.task.id, created.task.id);
    const storedCapability = await api.getCapability(siteAgentId, created.capability.id);
    assert.deepEqual(storedCapability.localizedNames, { zhCN: "打开订单历史", en: "Open Order History" });

    const legacyStyle = await api.createCapabilityTask(siteAgentId, {
      type: "generate",
      capability: {
        ...contract("navigateToHome"),
        description: "跳转回站点首页",
        goalTemplate: "跳转回站点首页",
        localizedNames: { zhCN: "跳转回站点首页", en: "navigateToHome" },
      },
    });
    const normalizedLegacy = await api.getCapability(siteAgentId, legacyStyle.capability.id);
    assert.deepEqual(normalizedLegacy.localizedNames, { zhCN: "跳转回站点首页", en: "Navigate To Home" });

    const chineseOnlyLegacy = await api.createCapabilityTask(siteAgentId, {
      type: "generate",
      capability: {
        ...contract("返回首页"),
        description: "返回站点首页",
        goalTemplate: "返回首页",
        localizedNames: { zhCN: "返回首页", en: "返回首页" },
      },
    });
    const normalizedChineseOnly = await api.getCapability(siteAgentId, chineseOnlyLegacy.capability.id);
    assert.equal(normalizedChineseOnly.localizedNames.zhCN, "返回首页");
    assert.equal(normalizedChineseOnly.localizedNames.en, "Unnamed Capability");
    assert.doesNotMatch(normalizedChineseOnly.localizedNames.en, /\p{Script=Han}/u);

    const misplacedChinese = await api.createCapabilityTask(siteAgentId, {
      type: "generate",
      capability: {
        ...contract("Search"),
        description: "搜索商品",
        localizedNames: { zhCN: "Search", en: "Search" },
      },
    });
    const normalizedMisplaced = await api.getCapability(siteAgentId, misplacedChinese.capability.id);
    assert.equal(normalizedMisplaced.localizedNames.zhCN, "搜索商品");
    assert.equal(normalizedMisplaced.localizedNames.en, "Search");
  } finally { await dispose(); }
});

test("D1 task detail binds acceptance proof and primary artifacts to the authoritative validation run", async () => {
  const { api, database, dispose } = await fixture();
  try {
    const siteAgentId = "task-proof-d1";
    await api.createSiteAgent({ id: siteAgentId, name: "Proof", url: "https://proof.test/" });
    const runId = "run-final-validation";
    const created = await api.createCapabilityTask(siteAgentId, {
      type: "generate",
      capability: {
        ...contract("Navigate home"),
        goalTemplate: "从商品详情返回首页",
        kind: "navigation",
        resultKind: "page",
        outputSchema: { type: "object", properties: { pageUrl: { type: "string" } }, required: ["pageUrl"] },
      },
      implementation: {
        kind: "module",
        module: { contentHash: "a".repeat(64), moduleUrl: "/modules/home.js", exportName: "capability" },
        proof: {
          version: 1,
          iterationId: "iteration-proof",
          author: "ai-program-author",
          rationale: "Navigate to home",
          alternativeIds: [],
          verifier: {
            success: [
              { kind: "url", value: "https://proof.test/home" },
              { kind: "text", value: "Welcome home" },
            ],
            noResult: [],
            businessRejection: [],
          },
          groundedTargetIds: [],
          createdAt: "2026-08-02T00:00:00.000Z",
        },
      },
      validation: {
        status: "passed",
        runId,
        startUrl: "https://proof.test/products/1",
        validatedContentHash: "a".repeat(64),
      },
    });
    const now = "2026-08-02T00:00:00.000Z";
    const finalArtifact = {
      id: "artifact-final",
      siteAgentId,
      learningJobId: created.task.id,
      runId,
      kind: "screenshot",
      role: "after-screenshot",
      label: "[after-screenshot] Final page",
      contentType: "image/png",
      size: 128,
      url: "/api/artifacts/artifact-final",
      createdAt: now,
    };
    const beforeArtifact = { ...finalArtifact, id: "artifact-before", role: "before-screenshot", label: "[before-screenshot] Before page", url: "/api/artifacts/artifact-before" };
    const videoArtifact = { ...finalArtifact, id: "artifact-video", kind: "video", role: "validation-video", label: "[validation-video] Validation recording", contentType: "video/webm", url: "/api/artifacts/artifact-video" };
    const historyArtifact = { ...finalArtifact, id: "artifact-history", runId: "run-failed", label: "Failed page", url: "/api/artifacts/artifact-history" };
    for (const artifact of [historyArtifact, beforeArtifact, finalArtifact, videoArtifact]) {
      await database.prepare(`INSERT INTO site_agent_v2_artifacts
        (id,site_agent_id,learning_job_id,run_id,kind,object_key,artifact_json,created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .bind(artifact.id, siteAgentId, created.task.id, artifact.runId, artifact.kind, `d1:${artifact.id}`, JSON.stringify(artifact), now)
        .run();
    }
    for (let index = 0; index < 65; index += 1) {
      const artifact = {
        ...historyArtifact,
        id: `artifact-history-${index}`,
        label: `Old attempt ${index}`,
        url: `/api/artifacts/artifact-history-${index}`,
        createdAt: `2026-08-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      };
      await database.prepare(`INSERT INTO site_agent_v2_artifacts
        (id,site_agent_id,learning_job_id,run_id,kind,object_key,artifact_json,created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .bind(artifact.id, siteAgentId, created.task.id, artifact.runId, artifact.kind, `d1:${artifact.id}`, JSON.stringify(artifact), artifact.createdAt)
        .run();
    }
    const run = {
      id: runId,
      learningJobId: created.task.id,
      siteAgentId,
      candidateId: created.version.id,
      runnerId: "runner-proof",
      mode: "validate",
      status: "passed",
      browser: { name: "chromium", version: "1", headless: true },
      startedAt: now,
      endedAt: now,
      startUrl: "https://proof.test/products/1",
      endUrl: "https://proof.test/home",
      steps: [{ stepId: "navigate", op: "adaptive", status: "passed", startedAt: now, endedAt: now }],
      outcome: {
        status: "success",
        code: "module_smoke_passed",
        summary: "Independent validation passed",
        evaluatedAt: now,
        evidence: {
          output: { pageUrl: "https://proof.test/home" },
          after: { url: "https://proof.test/home", title: "Home", heading: "Welcome home" },
          assertions: [
            { kind: "url", expected: "https://proof.test/home", actual: "https://proof.test/home", passed: true },
            { kind: "text", expected: "Welcome home", actual: "Welcome home", passed: true },
          ],
        },
      },
      artifactIds: [beforeArtifact.id, finalArtifact.id, videoArtifact.id],
    };
    await database.prepare(`INSERT INTO site_agent_v2_browser_runs
      (id,learning_job_id,validation_job_id,site_agent_id,candidate_id,status,run_json,started_at,ended_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(run.id, run.learningJobId, null, siteAgentId, run.candidateId, run.status, JSON.stringify(run), now, now)
      .run();

    const detail = await api.getCapabilityTaskDetail(siteAgentId, created.task.id);
    assert.equal(detail.verification.status, "passed");
    assert.equal(detail.verification.runId, runId);
    assert.equal(detail.verification.startUrl, "https://proof.test/products/1");
    assert.equal(detail.verification.endUrl, "https://proof.test/home");
    assert.deepEqual(detail.verification.evidenceArtifactIds, ["artifact-before", "artifact-final", "artifact-video"]);
    assert.deepEqual(detail.verification.evidenceRoles["before-screenshot"], ["artifact-before"]);
    assert.deepEqual(detail.verification.evidenceRoles["after-screenshot"], ["artifact-final"]);
    assert.deepEqual(detail.verification.evidenceRoles["validation-video"], ["artifact-video"]);
    assert.equal(detail.artifacts.some((artifact) => artifact.id === "artifact-final"), true, "authoritative artifacts survive the bounded history query");
    assert.equal(detail.verification.checks.every((check) => check.status === "passed"), true);
    assert.equal(detail.artifacts.some((artifact) => artifact.runId === "run-failed"), true);

    await database.prepare("UPDATE site_agent_v2_capability_versions SET validation_json=? WHERE id=?")
      .bind(JSON.stringify({ status: "passed", runId: "run-missing", startUrl: run.startUrl }), created.version.id)
      .run();
    const missingRunDetail = await api.getCapabilityTaskDetail(siteAgentId, created.task.id);
    assert.equal(missingRunDetail.verification.status, "incomplete");
    assert.equal(missingRunDetail.verification.source, "version-only");
    assert.equal(missingRunDetail.verification.runId, "run-missing");

    const foreignRun = { ...run, id: "run-foreign", learningJobId: "another-task" };
    await database.prepare(`INSERT INTO site_agent_v2_browser_runs
      (id,learning_job_id,validation_job_id,site_agent_id,candidate_id,status,run_json,started_at,ended_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(foreignRun.id, foreignRun.learningJobId, null, siteAgentId, foreignRun.candidateId, foreignRun.status, JSON.stringify(foreignRun), now, now)
      .run();
    await database.prepare("UPDATE site_agent_v2_capability_versions SET validation_json=? WHERE id=?")
      .bind(JSON.stringify({ status: "passed", runId: foreignRun.id, startUrl: run.startUrl }), created.version.id)
      .run();
    const foreignRunDetail = await api.getCapabilityTaskDetail(siteAgentId, created.task.id);
    assert.equal(foreignRunDetail.verification.status, "incomplete");
    assert.equal(foreignRunDetail.verification.source, "version-only");

    const noCriteria = await api.createCapabilityTask(siteAgentId, {
      type: "generate",
      capability: {
        ...contract("No acceptance criteria"),
        outputSchema: { type: "object", properties: {} },
      },
      implementation: { kind: "program", moduleRef: { contentHash: "d".repeat(64), moduleUrl: "/modules/no-criteria.js", exportName: "capability" } },
      validation: { status: "passed", runId: "run-no-criteria", startUrl: "https://proof.test/" },
    });
    const noCriteriaRun = {
      ...run,
      id: "run-no-criteria",
      learningJobId: noCriteria.task.id,
      candidateId: noCriteria.version.id,
      startUrl: "https://proof.test/",
      endUrl: "https://proof.test/done",
      artifactIds: [],
    };
    await database.prepare(`INSERT INTO site_agent_v2_browser_runs
      (id,learning_job_id,validation_job_id,site_agent_id,candidate_id,status,run_json,started_at,ended_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(noCriteriaRun.id, noCriteriaRun.learningJobId, null, siteAgentId, noCriteriaRun.candidateId, noCriteriaRun.status, JSON.stringify(noCriteriaRun), now, now)
      .run();
    const noCriteriaDetail = await api.getCapabilityTaskDetail(siteAgentId, noCriteria.task.id);
    assert.equal(noCriteriaDetail.verification.status, "incomplete");
    assert.equal(noCriteriaDetail.verification.checks.some((check) => check.id === "acceptance-criteria" && check.status === "incomplete"), true);
  } finally { await dispose(); }
});
