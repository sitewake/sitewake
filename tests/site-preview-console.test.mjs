import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("console v2 has stable workspaces and settings and legacy redirects", async () => {
  const [route, shell] = await Promise.all([read("../lib/console/route.ts"), read("../components/site-agent-console.tsx")]);
  const order = [...route.matchAll(/\{ id: "([a-z-]+)", icon:/g)].map((match) => match[1]);
  assert.deepEqual(order, ["overview", "agent", "sessions", "capabilities", "model", "settings"]);
  assert.match(route, /rawView === "runs" \|\| rawView === "effects"/);
  assert.match(route, /rawView === "appearance"/);
  assert.doesNotMatch(shell, /EffectCenter|SettingsWorkspace/);
  assert.match(shell, /data-console-ui="v2"/);
});

test("site preview queue is isolated, origin-pinned, bounded and management protected", async () => {
  const [schema, store, runner, previewRoute, artifactRoute] = await Promise.all([
    read("../db/site-agent-schema.ts"),
    read("../db/site-agent-store.ts"),
    read("../runner/browser-runner.ts"),
    read("../app/api/site-agents/[siteAgentId]/preview/route.ts"),
    read("../app/api/artifacts/route.ts"),
  ]);
  assert.match(schema, /site_agent_v2_preview_jobs/);
  assert.match(store, /new URL\(url\)\.origin !== origin/);
  assert.match(store, /job\.attempts < 3/);
  assert.match(store, /LIMIT 100 OFFSET 3/);
  assert.match(runner, /viewport: \{ width: 1440, height: 900 \}/);
  assert.match(runner, /timeout: 5_000/);
  assert.match(runner, /role: "site-preview"/);
  assert.match(runner, /"x-sitewake-runner-id": registeredRunnerIdForHeaders/);
  assert.match(runner, /headers\(\{ "content-type": metadata\.contentType/);
  assert.match(runner, /resolvePinnedCrawlOrigin\(job\.origin/);
  assert.match(previewRoute, /managementAuthorized\(request\)/);
  assert.match(previewRoute, /managementMutationAuthorized\(request\)/);
  assert.match(previewRoute, /overview\.profile\.entryUrl \|\| overview\.connection\?\.origin \|\| overview\.connection\?\.url/);
  assert.match(artifactRoute, /"preview-job"/);
  assert.match(artifactRoute, /"site-preview"/);
  assert.match(artifactRoute, /authorizeRunnerInstanceSession/);
});

test("sessions expose facts, redacted conversation, activity and replay without effect analysis", async () => {
  const [listRoute, detailRoute, page] = await Promise.all([
    read("../app/api/site-agents/[siteAgentId]/session-history/route.ts"),
    read("../app/api/site-agents/[siteAgentId]/session-history/[runId]/route.ts"),
    read("../components/console/session-history.tsx"),
  ]);
  assert.match(listRoute, /listEffectRuns/);
  assert.match(listRoute, /query: params\.get\("query"\)/);
  assert.match(listRoute, /outcome: params\.get\("status"\)/);
  assert.match(detailRoute, /getEffectRunDetail/);
  assert.match(detailRoute, /turn\.role === "user" \|\| turn\.role === "assistant"/);
  assert.match(detailRoute, /item\.kind !== "reasoning"/);
  assert.match(page, /DomReplayPlayer/);
  assert.doesNotMatch(page, /EffectSubmissionDetail|effect\/summary|effects\/records/);
});

test("overview retains an old screenshot while a replacement is running or fails", async () => {
  const overview = await read("../components/console/living-overview.tsx");
  assert.match(overview, /pending && preview/);
  const catalog = await read("../lib/console/overview-copy.ts");
  assert.match(overview, /copy\.keeping/);
  assert.match(catalog, /当前继续显示上一张/);
  assert.match(catalog, /本次刷新失败，已保留上一张截图/);
  assert.match(catalog, /截图生成失败，请稍后重试/);
  assert.match(overview, /preview \? copy\.refreshFailed : copy\.previewFailed/);
  assert.match(overview, /copy\.notDetected/);
  assert.match(catalog, /未检测到智能体入口/);
});
