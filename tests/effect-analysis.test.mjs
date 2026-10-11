import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function load(entry) {
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

const effects = await load("../lib/site-knowledge/effect-analysis.ts");

function source(activityTimeline = [], agentState = {}) {
  return {
    actorKey: "actor",
    receipts: [],
    run: {
      id: "run_1",
      revision: 1,
      controller: "page-agent",
      scope: {
        kind: "site",
        siteAgentId: "site_1",
        allowedOrigins: ["https://example.com"],
        knowledgeNamespaceIds: ["site_1"],
      },
      status: "completed",
      goal: "查排名并打开详情",
      input: {},
      conversation: [],
      agentState,
      activityTimeline,
      bindings: {},
      pageEpoch: 1,
      eventSequence: 1,
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:01:00.000Z",
      expiresAt: "2026-07-30T00:00:00.000Z",
    },
  };
}

function analysis(attributions) {
  return {
    version: 1,
    runId: "run_1",
    siteAgentId: "site_1",
    actorKey: "actor",
    submission: "查排名并打开详情",
    submittedAt: "2026-07-29T00:00:00.000Z",
    finishedAt: "2026-07-29T00:01:00.000Z",
    status: "completed",
    goalStatus: "achieved",
    goalChecks: [],
    attributions,
    primaryIssue: "none",
    improvements: [],
    reviewed: false,
    attempts: 1,
    createdAt: "2026-07-29T00:01:00.000Z",
    updatedAt: "2026-07-29T00:01:00.000Z",
  };
}

test("effect attribution rejects contribution without an observable execution path", () => {
  const problems = effects.validateEffectAnalysis(
    analysis([
      {
        area: "capability",
        subjectName: "榜单能力",
        used: true,
        execution: "succeeded",
        contribution: "direct",
        issue: "none",
        factRefs: [],
      },
      {
        area: "knowledge",
        subjectName: "网站知识",
        used: true,
        execution: "succeeded",
        contribution: "supporting",
        issue: "none",
        factRefs: [],
      },
      {
        area: "page",
        subjectName: "页面探索",
        used: true,
        execution: "succeeded",
        contribution: "direct",
        issue: "none",
        factRefs: [],
      },
    ]),
    source(),
  );

  assert.deepEqual(problems, [
    "未调用能力却判断能力产生贡献",
    "未检索知识却判断知识产生贡献",
    "没有页面过程却判断页面产生贡献",
  ]);
});

test("effect attribution cannot call a route miss without a route snapshot", () => {
  const item = {
    area: "capability",
    subjectName: "能力",
    used: false,
    execution: "not-used",
    contribution: "none",
    issue: "capability-routing-missed",
    factRefs: [],
  };
  assert.match(
    effects
      .validateEffectAnalysis(analysis([item]), source())
      .join("；"),
    /缺少能力路由快照/,
  );

  const withSnapshot = source([
    {
      id: "search_1",
      kind: "capability-search",
      state: "completed",
      label: "搜索已发布能力",
      output: { matches: 1, candidates: [{ id: "cap_1", score: 0.92 }] },
      createdAt: "2026-07-29T00:00:10.000Z",
    },
  ]);
  assert.deepEqual(
    effects.validateEffectAnalysis(analysis([item]), withSnapshot),
    [],
  );
});

test("failed execution cannot be counted as a direct contribution", () => {
  const problems = effects.validateEffectAnalysis(
    analysis([
      {
        area: "capability",
        subjectName: "榜单能力",
        used: true,
        execution: "failed",
        contribution: "direct",
        issue: "capability-call-failed",
        factRefs: [],
      },
    ]),
    source([
      {
        id: "cap_1",
        kind: "capability",
        state: "failed",
        label: "调用榜单能力",
        createdAt: "2026-07-29T00:00:10.000Z",
      },
    ]),
  );

  assert.deepEqual(problems, ["执行失败不能直接贡献"]);
});

test("effect page is submission-first and removes task-type panels", async () => {
  const sourceText = await import("node:fs/promises").then(({ readFile }) =>
    readFile(
      new URL("../components/effect-center.tsx", import.meta.url),
      "utf8",
    ),
  );
  // As above: wiring breaks in the component, literals break in the dictionary.
  assert.match(sourceText, /page\.title/);
  assert.match(sourceText, /page\.historyEyebrow/);
  assert.match(sourceText, /page\.goalRate/);
  const zhCatalog = await readFile(new URL("../lib/i18n/zh.ts", import.meta.url), "utf8");
  assert.match(zhCatalog, /title: "效果追踪"/);
  assert.match(zhCatalog, /historyEyebrow: "使用记录"/);
  assert.match(zhCatalog, /goalRate: "用户目标达成率"/);
  assert.doesNotMatch(sourceText, /结果总览|能力价值|知识价值|问答任务|操作任务/);
});
