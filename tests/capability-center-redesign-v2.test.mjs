import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function uiSources() {
  return Promise.all([
    readFile(new URL("../components/capability-center/capability-center-screen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/site-agent-console.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/capability-center/capability-center-api.ts", import.meta.url), "utf8"),
  ]);
}

async function screenSource() {
  return readFile(new URL("../components/capability-center/capability-center-screen.tsx", import.meta.url), "utf8");
}

test("Capability is the default primary tab and Task is the second tab", async () => {
  const screen = await screenSource();
  assert.match(screen, /if \(typeof window === ["']undefined["']\) return ["']capabilities["']/);
  const tabs = screen.slice(screen.indexOf('className="cc4-tabs"'));
  const capabilityTab = tabs.indexOf('module === "capabilities"');
  const taskTab = tabs.indexOf('module === "tasks"');
  const runnerTab = tabs.indexOf('module === "runners"');
  assert.ok(capabilityTab >= 0 && capabilityTab < taskTab && taskTab < runnerTab);
});

test("Capability display names are bilingual and selected from the browser language", async () => {
  const screen = await screenSource();
  const model = await readFile(new URL("../lib/capability-center/model.ts", import.meta.url), "utf8");
  const analyzer = await readFile(new URL("../lib/capability-center/proposal-analysis.ts", import.meta.url), "utf8");
  assert.match(model, /localizedNames:\s*\{\s*zhCN:\s*string;\s*en:\s*string\s*\}/);
  assert.match(screen, /navigator\.language/);
  assert.match(screen, /startsWith\(["']zh["']\)/);
  assert.match(screen, /localizedNames\?\.zhCN/);
  assert.match(screen, /localizedNames\?\.en/);
  assert.match(analyzer, /localizedNames\.zhCN/);
  assert.match(analyzer, /localizedNames\.en/);
});

test("Task evidence is presented as an auditable completion proof bound to one validation run", async () => {
  const screen = await screenSource();
  assert.match(screen, /能力完成证明/);
  assert.match(screen, /验收目标/);
  assert.match(screen, /验收条件/);
  assert.match(screen, /预期/);
  assert.match(screen, /实际/);
  assert.match(screen, /执行前截图/);
  assert.match(screen, /执行后截图/);
  assert.match(screen, /过程关键帧/);
  assert.match(screen, /<video\s+controls/);
  assert.match(screen, /可复盘过程文件/);
  assert.match(screen, /artifact\.kind === ["']trace["']/);
  assert.match(screen, /构建与失败历史材料/);
  assert.match(screen, /不作为当前能力完成结论/);
  assert.match(screen, /<details className=["']cc4-raw["']/);
});

test("Task starts on actionable reviews and every filter explains its count", async () => {
  const screen = await screenSource();

  assert.match(screen, /useState<TaskFilter>\(["']awaiting-review["']\)/);
  assert.match(screen, />任务\s*<em>待处理\s*\{reviewCount\}<\/em>/);
  assert.match(screen, /all:\s*tasks\.length/);
  assert.match(screen, /taskFilterCounts\[filter\]/);
  assert.match(screen, /payload\.tasks\.find\(\(item\)\s*=>\s*item\.status\s*===\s*["']awaiting-review["']\)/);
});

test("Task proof media uses declared roles without guessing missing evidence", async () => {
  const screen = await screenSource();

  for (const role of ["before-screenshot", "after-screenshot", "keyframe", "validation-video"]) {
    assert.match(screen, new RegExp(role));
  }
  assert.match(screen, /执行前截图/);
  assert.match(screen, /执行后截图/);
  assert.match(screen, /过程关键帧/);
  assert.match(screen, /未标注角色的截图/);
  assert.match(screen, /不参与前后状态推断/);
});

test("incomplete legacy evidence exposes revalidation while leaving the final decision to the administrator", async () => {
  const screen = await screenSource();
  assert.match(screen, /taskAction\("revalidate"\)/);
  assert.match(screen, /重新验证证据/);
  assert.match(screen, /人工仍可结合实际情况作出最终决定/);
});

test("the capability-center primary navigation is Capability, Task, and Runner", async () => {
  const [center] = await uiSources();

  assert.match(center, />\s*能力\s*</);
  assert.match(center, />\s*任务(?:\s*<|\s)/);
  assert.match(center, /module\s*===\s*["']runners["']/i);
  assert.match(center, />Runner<\/button>/i);
  assert.doesNotMatch(center, />\s*生产队列\s*</);
});

test("the redesigned UI reads the four-table capability-center API instead of legacy Project projections", async () => {
  const [center, , api] = await uiSources();
  const capabilityCenterClient = `${center}\n${api}`;

  for (const resource of ["capabilities", "tasks", "proposals"]) {
    assert.match(
      capabilityCenterClient,
      new RegExp(`capability-center\\/${resource}`),
      `missing ${resource} API integration`,
    );
  }
  assert.doesNotMatch(capabilityCenterClient, /\/capability-projects(?:[/?`"'])/);
});

test("the Task module filters lifecycle states and supports archiving completed history", async () => {
  const [center] = await uiSources();

  assert.match(center, /taskStatusFilter|taskStatus/i);
  for (const state of ["queued", "running", "awaiting-review", "completed", "failed"]) {
    assert.match(center, new RegExp(state.replace("-", "[-_]"), "i"), state);
  }
  assert.match(center, /archiv(?:e|ed)|归档/i);
});

test("manual review is rendered inside Task as the final step before formal publication", async () => {
  const [center] = await uiSources();
  const taskModule = center.slice(
    Math.max(0, center.search(/catalogView\s*===\s*["']tasks["']/i)),
  );

  assert.match(taskModule, /人工(?:审核|验证)/);
  assert.match(taskModule, /(?:最后一步|最终步骤|terminal|final step)/i);
  assert.match(taskModule, /(?:批准|通过)[\s\S]{0,500}(?:正式能力|发布)/i);
});

test("duplicate Proposals stay visible in the Task module without being counted as Tasks", async () => {
  const [center, , api] = await uiSources();

  assert.match(api, /capability-center\/proposals/);
  assert.match(center, /duplicate/i);
  assert.match(center, /提案/);
  assert.doesNotMatch(
    center,
    /(?:taskProjects|capabilityTasks)\s*=\s*[^;]{0,1200}(?:duplicateProposals|proposals\.filter)/i,
  );
});

test("Capability detail centers description, immutable contract, and separated execution evidence", async () => {
  const [center] = await uiSources();

  assert.match(center, /能力描述|description/i);
  assert.match(center, /能力契约|contract/i);
  assert.match(center, /输入契约|input schema/i);
  assert.match(center, /输出契约|output schema/i);
  assert.match(center, /用户执行/);
  assert.match(center, /系统验证执行|系统验证/);
});

test("Capability actions expose reversible unpublish and irreversible logical delete", async () => {
  const [center] = await uiSources();

  assert.match(center, /下架/);
  assert.match(center, /重新上架/);
  assert.match(center, /删除能力|逻辑删除/);
  assert.match(center, /不可恢复/);
  assert.doesNotMatch(center, /恢复(?:已删除)?能力/);
});

test("Runner management is embedded in Capability Center instead of remaining a site-level peer", async () => {
  const [center, consoleSource] = await uiSources();

  assert.match(center, /import\s*\{?[\s\S]*RunnerManagement[\s\S]*\}?\s*from\s*["']\.\.\/runner-management["']/);
  assert.match(center, /<RunnerManagement\b/);
  assert.doesNotMatch(
    consoleSource,
    /\{\s*id:\s*["']runners["']\s*,\s*label:/,
    "Runner is temporarily a child of Capability Center, not a peer site module",
  );
});

test("legacy system Runner deep links remain compatible by entering Capability Center", async () => {
  const [, consoleSource] = await uiSources();

  assert.match(
    consoleSource,
    /searchParams\.get\(["']view["']\)\s*===\s*["']runners["'][\s\S]{0,180}searchParams\.get\(["']siteAgentId["']\)[\s\S]{0,80}searchParams\.get\(["']site["']\)/,
  );
  assert.match(
    consoleSource,
    /searchParams\.set\(["']view["'],\s*["']capabilities["']\)[\s\S]{0,120}searchParams\.set\(["']module["'],\s*["']runners["']\)/,
    "legacy ?scope=system&view=runners links must resolve to Capability Center's Runner child view",
  );
});
