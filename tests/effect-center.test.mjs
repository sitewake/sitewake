import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function bundledModule(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
}

// Engagement events are stamped with `new Date()` by the store, so anchoring
// fixtures to a fixed calendar date silently drops them out of the query window
// once that date passes. Everything here is relative to one `NOW` instead, so
// the run duration stays exact.
const NOW = Date.now();
const RUN_STARTED_AT = new Date(NOW - 60_000).toISOString();
const RUN_ENDED_AT = new Date(NOW - 56_000).toISOString();
const QUERY_RANGE = {
  from: new Date(NOW - 86_400_000).toISOString(),
  to: new Date(NOW + 86_400_000).toISOString(),
};

function runFixture({
  id,
  actor,
  status = "completed",
  outcomeStatus = "success",
  outcomeCode = "completed",
  outcomeSummary = "已找到结果",
  capabilityId = "capability-search",
  knowledge = true,
  startedAt = RUN_STARTED_AT,
  endedAt = RUN_ENDED_AT,
}) {
  const activityTimeline = [
    ...(knowledge
      ? [
          {
            id: `${id}:knowledge`,
            sessionId: id,
            kind: "knowledge",
            state: "completed",
            label: "查询网站知识",
            url: "https://shop.example/",
            createdAt: startedAt,
          },
        ]
      : []),
    ...(capabilityId
      ? [
          {
            id: `${id}:capability`,
            sessionId: id,
            kind: "capability",
            state: status === "completed" ? "completed" : "failed",
            label: "调用能力",
            capabilityId,
            url: "https://shop.example/search",
            createdAt: endedAt,
          },
        ]
      : []),
  ];
  return {
    id,
    scope: { siteAgentId: "shop" },
    goal: "搜索无线耳机",
    input: { keyword: "无线耳机" },
    output: status === "completed" ? { count: 12 } : undefined,
    status,
    outcome: {
      status: outcomeStatus,
      code: outcomeCode,
      summary: outcomeSummary,
    },
    activityTimeline,
    conversation: [],
    checkpoint: capabilityId
      ? { mode: "compiled", capabilityId }
      : { mode: "adaptive" },
    activePort: {
      browserSessionId: actor,
      url: "https://shop.example/search",
    },
    agentState: {
      effectActorKey: actor,
      effectReleaseId: "release-3",
      effectReleaseVersion: 3,
      effectStartUrl: "https://shop.example/",
    },
    pageEpoch: 2,
    createdAt: startedAt,
    updatedAt: endedAt,
  };
}

test("effect facts and summaries connect user outcomes to capability and knowledge use", async () => {
  const store = await bundledModule("../db/effect-store.ts");
  const success = runFixture({ id: "run-success", actor: "actor-a" });
  const failure = runFixture({
    id: "run-failure",
    actor: "actor-b",
    status: "failed",
    outcomeStatus: "execution-fault",
    outcomeCode: "target_not_found",
    outcomeSummary: "页面目标发生变化",
  });

  const fact = await store.effectFactFromAgentRun(success);
  assert.equal(fact.capabilityUsed, true);
  assert.equal(fact.knowledgeUsed, true);
  assert.equal(fact.knowledgeContribution, "queried-only");
  assert.equal(fact.capabilityContribution, "invoked-only");
  assert.equal(fact.completionVerdict, "claimed-success");
  assert.equal(fact.durationMs, 4_000);
  assert.equal(fact.failureCategory, "none");

  const failedFact = await store.effectFactFromAgentRun(failure);
  assert.equal(failedFact.failureCategory, "page-drift");
  // The failure's class and stage are written with the fact; a success carries none.
  assert.equal(failedFact.failureClass, "site-changed");
  assert.equal(failedFact.failureStage, "runtime.stage");
  assert.equal(fact.failureClass, undefined);

  await store.persistEffectRun(success);
  await store.persistEffectRun(failure);
  for (const type of [
    "agent-seen",
    "agent-opened",
    "goal-submitted",
    "result-seen",
  ]) {
    await store.appendEngagementEvent({
      siteAgentId: "shop",
      browserSessionId: "browser-a",
      type,
    });
  }

  const summary = await store.summarizeEffectRuns("shop", QUERY_RANGE);
  assert.equal(summary.totals.tasks, 2);
  assert.equal(summary.totals.users, 2);
  assert.equal(summary.rates.goalSuccess, 0.5);
  assert.equal(summary.rates.capabilityReuse, 1);
  assert.equal(summary.capabilities[0].tasks, 2);
  assert.equal(summary.issues[0].category, "page-drift");
  assert.deepEqual(summary.engagement, {
    seenUsers: 1,
    openedUsers: 1,
    goalUsers: 1,
    resultUsers: 1,
    openRate: 1,
    goalRate: 1,
    resultRate: 1,
  });

  const page = await store.listEffectRuns("shop", {
    ...QUERY_RANGE,
    outcome: "failed",
    limit: 20,
  });
  assert.deepEqual(page.records.map((item) => item.runId), ["run-failure"]);
});

test("knowledge lookup is not credited when the answer actually comes from the current page", async () => {
  const store = await bundledModule("../db/effect-store.ts");
  const run = runFixture({
    id: "run-minor-policy",
    actor: "actor-policy",
    capabilityId: null,
  });
  run.goal = "本站在未成年人保护是什么政策？";
  run.output = {
    text: "我们不会主动收集未成年人的个人信息，并建议监护人指导未成年人使用本站服务。",
  };
  run.outcome.summary = "已回答未成年人保护政策";
  run.checkpoint = {
    mode: "adaptive",
    adaptiveTrace: {
      startSnapshot: {
        id: "snapshot-privacy",
        sessionId: run.id,
        documentId: "privacy",
        sequence: 1,
        url: "https://example.com/privacy",
        title: "隐私政策",
        heading: "未成年人保护",
        visibleText:
          "未成年人保护 我们不会主动收集未成年人的个人信息，并建议监护人指导未成年人使用本站服务。",
        links: [],
        capturedAt: run.createdAt,
      },
    },
  };
  run.activePort.url = "https://example.com/privacy";
  run.agentState.effectStartUrl = "https://example.com/privacy";

  const fact = await store.effectFactFromAgentRun(run);
  assert.equal(fact.completionVerdict, "verified-success");
  assert.equal(fact.completionMethod, "current-page-reading");
  assert.equal(fact.knowledgeContribution, "queried-only");
  assert.match(fact.knowledgeReason, /不能证明/);
  assert.equal(fact.capabilityContribution, "none");
  assert.ok(
    fact.evidenceRefs.some((item) => item.kind === "page-snapshot"),
  );
});

test("effect center has durable storage, protected management reads, and anonymous collection", async () => {
  const [schema, store, summaryRoute, recordsRoute, detailRoute, eventsRoute, client, consoleRouteSource, consoleSource, effectSource, zh] =
    await Promise.all([
      readFile(new URL("../db/site-agent-schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/effect-store.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/site-agents/[siteAgentId]/effects/summary/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/site-agents/[siteAgentId]/effects/records/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/site-agents/[siteAgentId]/effects/records/[runId]/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/site-agents/[siteAgentId]/effects/events/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8"),
      readFile(new URL("../lib/console/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../components/site-agent-console.tsx", import.meta.url), "utf8"),
      readFile(new URL("../components/effect-center.tsx", import.meta.url), "utf8"),
      readFile(new URL("../lib/i18n/zh.ts", import.meta.url), "utf8"),
    ]);

  for (const table of [
    "site_agent_v3_usage_facts",
    "site_agent_v3_engagement_events",
    "site_agent_v3_effect_analyses",
    "site_agent_v3_effect_analysis_jobs",
    "site_agent_v3_effect_improvements",
  ])
    assert.match(schema, new RegExp(table));
  for (const route of [summaryRoute, recordsRoute, detailRoute])
    assert.match(route, /managementAuthorized\(request\)/);
  assert.doesNotMatch(eventsRoute, /managementAuthorized/);
  assert.match(store, /effectActorKey/);
  assert.doesNotMatch(store, /event\.browserSessionId/);
  for (const event of ["agent-seen", "agent-opened", "goal-submitted", "result-seen"])
    assert.match(client, new RegExp(event));
  assert.doesNotMatch(consoleSource, /import \{ EffectCenter \}/);
  assert.match(consoleSource, /SessionHistory/);
  assert.match(consoleRouteSource, /rawView === "runs" \|\| rawView === "effects"/);
  for (const section of [
    "效果追踪",
    "分析队列",
    "用户目标达成率",
    "能力有效贡献率",
    "待处理改进项",
    "使用记录",
  ])
    assert.match(`${effectSource}\n${zh}`, new RegExp(section));
  for (const removed of ["结果总览", "能力价值", "知识价值", "问答任务", "操作任务"])
    assert.doesNotMatch(effectSource, new RegExp(removed));
  assert.doesNotMatch(store, /await backfillEffectFacts\\(siteAgentId\\)/);
});
