import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const SITE_ORIGIN = "http://site.agent.test";
const CONTROL_ORIGIN = "http://control.agent.test";
const artifactsDirectory = ".agent-lab";
const headed = process.env.SITEWAKE_AGENT_LAB_HEADED === "1";
const traceEnabled = process.env.SITEWAKE_AGENT_LAB_TRACE === "1";
const benchmark = process.env.SITEWAKE_AGENT_LAB_BENCHMARK === "1";
const requestedCase = process.env.SITEWAKE_AGENT_LAB_CASE;
const now = "2026-07-18T00:00:00.000Z";

const sdk = await readFile("public/sitewake.js", "utf8");
const adaptiveSdk = await readFile("public/sitewake-adaptive.js", "utf8");

function hash(value) {
  let current = 2166136261;
  for (const character of JSON.stringify(value)) current = Math.imul(current ^ character.charCodeAt(0), 16777619);
  return (current >>> 0).toString(36);
}

function pageContext(run) {
  return {
    pageEpoch: run.pageEpoch,
    url: run.activePort?.url,
    documentId: run.activePort?.documentId,
    browserPortId: run.activePort?.id,
  };
}

function stableContext(run) {
  const checkpoint = run.checkpoint || {};
  return {
    runId: run.id,
    goal: run.goal,
    conversation: run.conversation,
    capabilityInvocation: checkpoint.capabilityId ? { capabilityId: checkpoint.capabilityId, input: checkpoint.input } : undefined,
    programCursor: checkpoint.cursor,
    bindings: run.bindings,
    completedStepIds: checkpoint.completedStepIds || [],
    toolReceipts: checkpoint.toolReceipts || [],
    activityTimeline: run.activityTimeline,
  };
}

function taskInvariant(snapshot) {
  const stable = snapshot.stable;
  return {
    runId: stable.runId,
    goal: stable.goal,
    conversation: stable.conversation,
    capabilityInvocation: stable.capabilityInvocation,
  };
}

function scene(id, name, pathnamePattern, parameters = [], verifier = {}) {
  return {
    id, name, description: name, semanticSource: "ai", evidenceStatus: "observed", lifecycle: "observed", identityConfidence: 1,
    evidence: { linkLabels: [], observedUrls: [`${SITE_ORIGIN}${pathnamePattern.replace(/\{[^}]+\}/g, "lamp")}`], titles: [name], headings: [name] },
    urlTemplates: [{ id: `url-${id}`, originPattern: SITE_ORIGIN, pathnamePattern, query: {} }],
    parameters, verifier, directEntry: "verified", sourceObservationIds: [], updatedAt: now,
  };
}

function releaseFixture() {
  const home = scene("scene-home", "Agent Lab 首页", "/", [], { headingIncludes: ["Agent Lab 首页"] });
  const results = scene("scene-results", "搜索结果", "/results/{keyword}", [{ id: "keyword", name: "关键词", type: "string", required: true, examples: ["lamp"] }], { headingIncludes: ["搜索结果"] });
  const target = {
    id: "result-count", name: "结果数量", description: "搜索结果数量", role: "status", accessibleNames: ["结果数量"],
    locatorVariants: [{ id: "count-css", strategy: "css", role: "status", value: "#result-count", score: 1, successes: 1, failures: 0, lastSeenAt: now }],
    sceneIds: ["scene-results"], attributes: {}, updatedAt: now,
  };
  const searchOperation = {
    id: "operation-search", name: "执行关键词搜索", description: "进入关键词搜索结果", kind: "task", evidenceSource: "ai-authored",
    applicability: { scope: "any-scene", evidenceSceneIds: ["scene-home"] }, fromSceneId: "*", toSceneId: "scene-results",
    inputs: { type: "object", properties: { keyword: { type: "string", description: "关键词" } }, required: ["keyword"] },
    outputs: { type: "object", properties: { count: { type: "number" } }, required: ["count"] }, preconditions: [], effects: ["scene:scene-results"],
    implementations: [{
      id: "implementation-search", conditions: [], successes: 1, failures: 0, sourceEpisodeIds: [],
      program: { version: 2, steps: [
        { id: "navigate-results", op: "navigate", sceneId: "scene-results", bindings: { keyword: { source: "input", path: "keyword" } }, timeoutMs: 4_000 },
        { id: "extract-count", op: "extract", targetId: "result-count", schema: { type: "number" }, saveAs: "count", timeoutMs: 4_000 },
      ] },
      authored: { kind: "page-program", program: { version: 2, steps: [
        { id: "navigate-results", op: "navigate", sceneId: "scene-results", bindings: { keyword: { source: "input", path: "keyword" } }, timeoutMs: 4_000 },
        { id: "extract-count", op: "extract", targetId: "result-count", schema: { type: "number" }, saveAs: "count", timeoutMs: 4_000 },
      ] }, proof: { version: 1, iterationId: "agent-lab", author: "ai-program-author", rationale: "fixture", alternativeIds: [], verifier: { success: [{ kind: "scene", value: "scene-results" }], noResult: [], businessRejection: [] }, groundedTargetIds: ["result-count"], createdAt: now } },
    }], verification: { sceneId: "scene-results", targetIds: ["result-count"] }, status: "verified", updatedAt: now,
  };
  const clickTarget = {
    id: "open-results", name: "打开固定搜索结果", description: "测试点击导航", role: "link", accessibleNames: ["打开 lamp 搜索结果"],
    locatorVariants: [{ id: "open-results-css", strategy: "css", role: "link", value: "#open-results", score: 1, successes: 1, failures: 0, lastSeenAt: now }], sceneIds: ["scene-home"], attributes: {}, updatedAt: now,
  };
  const clickOperation = {
    id: "operation-click", name: "点击搜索入口", description: "通过真实锚点进入结果页", kind: "navigation", evidenceSource: "shared-navigation",
    applicability: { scope: "scene-set", sceneIds: ["scene-home"], evidenceSceneIds: ["scene-home"] }, fromSceneId: "scene-home", toSceneId: "scene-results",
    inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: { count: { type: "number" } }, required: ["count"] }, preconditions: [], effects: ["scene:scene-results"],
    implementations: [{ id: "implementation-click", conditions: [], successes: 1, failures: 0, sourceEpisodeIds: [], program: { version: 2, steps: [
      { id: "click-results", op: "click", targetId: "open-results", timeoutMs: 4_000, transition: { kind: "document", expectedSceneIds: ["scene-results"], expectedOrigin: SITE_ORIGIN } },
      { id: "extract-count-after-click", op: "extract", targetId: "result-count", schema: { type: "number" }, saveAs: "count", timeoutMs: 4_000 },
    ] } }], verification: { sceneId: "scene-results", targetIds: ["result-count"] }, status: "verified", updatedAt: now,
  };
  const capability = {
    id: "capability-search", kind: "task", resultKind: "data", exposure: "public", name: "搜索实验商品", description: "搜索商品并返回结果数量", normalizedGoal: "搜索 keyword", goalTemplate: "搜索 {keyword}", aliases: ["查找 lamp", "搜索 lamp"],
    inputs: searchOperation.inputs, outputs: { type: "object", properties: { count: { type: "number", description: "结果数量" } }, required: ["count"] }, outcomes: [{ id: "search-success", status: "success", code: "success", description: "搜索完成", classifiers: [] }],
    plans: [{ id: "plan-search", entrySceneIds: ["*"], steps: [{ operationId: "operation-search", bindings: { keyword: { source: "input", path: "keyword" } } }], outputBindings: { count: { source: "state", path: "count" } } }], sourceEpisodeIds: [], confidence: 1, status: "available", updatedAt: now,
  };
  const openResultsCapability = {
    id: "capability-open-results", origin: "admin-created", kind: "navigation", resultKind: "data", exposure: "public", name: "打开搜索结果", description: "通过真实链接进入搜索页", normalizedGoal: "打开搜索结果", goalTemplate: "打开搜索结果", aliases: ["进入搜索结果", "打开搜索结果页"],
    inputs: { type: "object", properties: {} }, outputs: { type: "object", properties: { count: { type: "number" } }, required: ["count"] }, outcomes: [],
    plans: [{ id: "plan-click", entrySceneIds: ["scene-home"], steps: [{ operationId: "operation-click", bindings: {} }], outputBindings: { count: { source: "state", path: "count" } } }], sourceEpisodeIds: [], confidence: 1, status: "available", updatedAt: now,
  };
  const navigationTool = {
    id: "click", siteAgentId: "runtime-lab", intentKey: "navigate_to_results", name: "打开搜索结果", description: "到达搜索结果页面",
    aliases: ["进入搜索结果", "打开搜索结果页"], targetSceneId: "scene-results",
    inputs: openResultsCapability.inputs, outputs: openResultsCapability.outputs,
    applicability: clickOperation.applicability,
    strategies: [{ kind: "shared-component", operationId: "operation-click", evidenceSceneIds: ["scene-home"] }],
    verifier: { sceneId: "scene-results" },
    source: { kind: "knowledge-compiled", knowledgeRevision: 1, dependencyHash: "runtime-lab-click", evidenceRefs: [] },
    status: "verified", usedByCapabilityIds: [openResultsCapability.id], updatedAt: now,
  };
  const release = {
    schemaVersion: "site-agent.v2", id: "runtime-lab:release:1", siteAgentId: "runtime-lab", version: 1, createdAt: now,
    profile: { name: "Runtime Lab", description: "受控 Agent 测试站", semanticSource: "ai", visibility: "sandbox", vocabulary: {}, suggestedGoals: ["搜索 lamp"] },
    agentConfig: { appearance: { preset: "orb", palette: "mint", launcherPosition: "bottom-right" }, overrides: {}, features: { showSuggestions: true, showTeachAfterFailure: true, showNewChat: true, showKnowledgeVersion: true }, suggestions: [] },
    scenes: [home, results], linkReferences: [], targets: [target, clickTarget], operations: [searchOperation, clickOperation], navigationTools: [navigationTool], capabilities: [capability, openResultsCapability], outcomes: [], evalSummary: { passed: true, evaluatedEpisodes: 0, successfulEpisodes: 0, failedEpisodes: 0, generatedAt: now }, sourceEpisodeIds: [], contentHash: "agent-lab",
  };
  return release;
}

function htmlFor(url) {
  const pathname = new URL(url).pathname;
  const script = `<script src="${CONTROL_ORIGIN}/sitewake.js" data-site-agent="runtime-lab" data-endpoint="${CONTROL_ORIGIN}" data-visibility="sandbox" data-open="true" defer></script>`;
  if (pathname === "/hash-router") {
    return `<!doctype html>
      <meta charset="utf-8">
      <title>Hash router fixture</title>
      <main><output id="hash-route">booting</output></main>
      <script>
        window.__hashRouteEvents = [];
        window.__renderHashRoute = function (event) {
          var route = location.hash === "#/cart" ? "cart" : "transport";
          document.querySelector("#hash-route").textContent = route;
          window.__hashRouteEvents.push({ type: event && event.type || "initial", hash: location.hash, route: route });
        };
        window.addEventListener("hashchange", window.__renderHashRoute);
        window.addEventListener("popstate", window.__renderHashRoute);
        window.__renderHashRoute();
      </script>
      ${script}`;
  }
  if (pathname.startsWith("/detail/")) {
    return `<!doctype html><meta charset="utf-8"><title>结果详情</title><main><h1>结果详情</h1><p id="detail-value">lamp 的完整结果详情</p><a href="/">返回首页</a></main>${script}`;
  }
  if (pathname === "/login") {
    return `<!doctype html><meta charset="utf-8"><title>需要登录</title><main><h1>需要登录</h1><p>请登录后继续。</p><label>账户 <input autocomplete="username"></label><label>密码 <input type="password" autocomplete="current-password"></label><button>登录</button></main>${script}`;
  }
  if (pathname.startsWith("/results/")) {
    const keyword = decodeURIComponent(pathname.split("/").at(-1) || "");
    const noResult = keyword === "none";
    return `<!doctype html><meta charset="utf-8"><title>搜索结果</title><main><h1>搜索结果</h1><p>关键词：${keyword}</p><output id="result-count" role="status" aria-label="结果数量">${noResult ? 0 : 7}</output>${noResult ? "<p>没有匹配结果</p>" : '<a id="open-detail" href="/detail/lamp">查看 lamp 详情</a>'}<a href="/">返回首页</a></main>${script}`;
  }
  return `<!doctype html><meta charset="utf-8"><title>Agent Lab 首页</title><main><h1>Agent Lab 首页</h1><form action="/results/lamp"><label>搜索 <input aria-label="搜索关键词" name="keyword"></label><button>搜索</button></form><a id="open-results" href="/results/lamp" aria-label="打开 lamp 搜索结果">打开 lamp 搜索结果</a><a id="open-login" href="/login">打开登录页</a><button id="slow">慢操作</button><button id="add-moss" type="button" aria-label="将 Moss 休闲椅加入购物车" onclick="document.querySelector('#effect-status').textContent='Moss 休闲椅已加入购物车。购物车 1 件商品。'">将 Moss 休闲椅加入购物车</button><button id="checkout" type="button" aria-label="打开购物车并结算" onclick="document.querySelector('#effect-status').textContent='订单结算已提交。'">打开购物车并结算</button><output id="effect-status" role="status">购物车 0 件商品。</output></main>${script}`;
}

class ControlPlane {
  constructor() {
    this.release = releaseFixture();
    this.runs = new Map(); this.events = []; this.modelCalls = []; this.episodeBodies = []; this.contextSnapshots = []; this.checkpointWrites = 0; this.handoffs = 0; this.claims = 0; this.launchClaims = 0; this.launchPatches = []; this.sessionPatches = []; this.episodes = 0; this.sequence = 0;
    this.hashTaskLaunch = { goal: "hello", input: {}, mode: "run", executionMode: "run" };
    this.taskLaunch = {
      goal: "打开搜索结果",
      capabilityId: "navigation-tool:click",
      input: {},
      mode: "run",
      executionMode: "debug",
      releaseId: this.release.id,
      releaseVersion: this.release.version,
      revisionId: "revision-open-results-1",
    };
  }
  timestamp(name) { this.events.push({ name, at: performance.now() }); }
  runView(run) { return JSON.parse(JSON.stringify(run)); }
  create(body) {
    const id = `run_${++this.sequence}`; const token = `${id}.token`;
    const run = { id, revision: 1, scope: { kind: "site", siteAgentId: "runtime-lab", allowedOrigins: [SITE_ORIGIN], knowledgeNamespaceIds: ["runtime-lab"] }, status: "running", goal: body.goal, input: body.input || {}, conversation: [...(body.conversation || []), { role: "user", content: body.goal, at: now }], agentState: {}, activityTimeline: [], bindings: {}, pageEpoch: 1, eventSequence: 1, createdAt: now, updatedAt: now, expiresAt: "2030-01-01T00:00:00.000Z", activePort: { id: "port_1", documentId: body.documentId, browserSessionId: body.browserSessionId, origin: body.origin, url: body.url, pageEpoch: 1, state: "active", claimedAt: now, lastSeenAt: now, leaseExpiresAt: "2030-01-01T00:00:00.000Z" } };
    this.runs.set(id, { run, token, handoffToken: undefined }); this.timestamp("run created"); return { run: this.runView(run), resumeToken: token, persistence: "memory" };
  }
  authorize(id, token, allowHandoff = false) { const entry = this.runs.get(id); if (!entry || (entry.token !== token && (!allowHandoff || entry.handoffToken !== token))) throw new Error("agent_run_token_rejected"); return entry; }
  mutate(id, token, body, event) { const entry = this.authorize(id, token); const run = entry.run; if (body.expectedRevision !== undefined && Number(body.expectedRevision) !== run.revision) throw new Error("agent_run_revision_conflict"); if (body.pageEpoch !== undefined && Number(body.pageEpoch) !== run.pageEpoch) throw new Error("agent_run_page_superseded"); Object.assign(run, body.patch || {}); run.revision += 1; run.eventSequence += 1; run.updatedAt = new Date().toISOString(); this.timestamp(event); return entry; }
  handoff(id, token, body) { const entry = this.mutate(id, token, { expectedRevision: body.expectedRevision, pageEpoch: body.pageEpoch, patch: { status: "awaiting-page", checkpoint: body.checkpoint, programCursor: body.checkpoint?.cursor } }, "handoff committed"); entry.handoffToken = `${id}.handoff`; this.handoffs += 1; this.contextSnapshots.push({ point: "before-navigation", stable: stableContext(entry.run), page: pageContext(entry.run) }); return { run: this.runView(entry.run), handoffToken: entry.handoffToken, expiresAt: "2030-01-01T00:00:00.000Z" };
  }
  claim(id, body) { const entry = this.authorize(id, body.token, true); const run = entry.run; if (run.status !== "awaiting-page" && run.status !== "running") throw new Error("agent_run_not_claimable"); run.pageEpoch += 1; run.revision += 1; run.eventSequence += 1; run.status = "running"; run.activePort = { id: `port_${run.pageEpoch}`, documentId: body.documentId, browserSessionId: body.browserSessionId, origin: body.origin, url: body.url, pageEpoch: run.pageEpoch, state: "active", claimedAt: now, lastSeenAt: now, leaseExpiresAt: "2030-01-01T00:00:00.000Z" }; if (body.checkpoint) { run.checkpoint = body.checkpoint; run.bindings = { ...run.bindings, ...(body.checkpoint.output || {}) }; }
    entry.token = body.token; entry.handoffToken = undefined; this.claims += 1; this.timestamp("BrowserPort claimed"); this.contextSnapshots.push({ point: "after-claim", stable: stableContext(run), page: pageContext(run) }); this.contextSnapshots.push({ point: "before-first-directive", stable: stableContext(run), page: pageContext(run) }); return { run: this.runView(run), resumeToken: entry.token, persistence: "memory" };
  }
  checkpoint(id, token, body) { const entry = this.mutate(id, token, { expectedRevision: body.expectedRevision, pageEpoch: body.pageEpoch, patch: { checkpoint: body.checkpoint, bindings: { ...this.runs.get(id).run.bindings, ...(body.bindings || {}) }, activityTimeline: body.checkpoint?.activityTimeline || [] } }, "checkpoint"); this.checkpointWrites += 1; return { run: this.runView(entry.run), persistence: "memory" }; }
  finish(id, token, body) { const entry = this.mutate(id, token, { expectedRevision: body.expectedRevision, pageEpoch: body.pageEpoch, patch: { status: body.status, output: body.output, outcome: body.outcome, activityTimeline: body.activityTimeline || this.runs.get(id).run.activityTimeline, conversation: [...this.runs.get(id).run.conversation, ...(body.assistantText ? [{ role: "assistant", content: body.assistantText, at: now }] : [])] } }, "result rendered"); return { run: this.runView(entry.run), persistence: "memory" }; }
  cancel(id, token) { const entry = this.authorize(id, token); entry.run.status = "cancelled"; entry.run.revision += 1; this.timestamp("cancelled"); return { run: this.runView(entry.run), persistence: "memory" }; }
  async model(payload) { this.modelCalls.push(payload); const modelIndex = this.modelCalls.length; this.timestamp(`model ${modelIndex} started`); const delay = this.modelDelayByCall?.[modelIndex] ?? this.modelDelayMs; if (delay) await new Promise((resolve) => setTimeout(resolve, delay)); this.timestamp(`model ${modelIndex} completed`); const content = "已完成搜索。\n\n- 关键词：**lamp**\n- 找到 **7** 个结果";
    if (payload.tools?.some?.((entry) => entry.function?.name === "AgentOutput")) {
      const action = this.adaptivePlan?.shift() || { done: { text: "已完成探索。", success: true, outcome: "success", output: { count: 7 } } };
      return { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "AgentOutput", arguments: JSON.stringify({ evaluation_previous_goal: "页面状态已确认", memory: "继续当前任务", next_goal: "执行下一步", action }) } }] } }] };
    }
    if (this.mainPlan?.length) return this.mainPlan.shift();
    const mainAgentTools = payload.tools?.filter?.((entry) => entry.function?.name?.startsWith("capability_")) || [];
    if (mainAgentTools.length) {
      const goal = String(payload.messages?.findLast?.((entry) => entry.role === "user")?.content || "");
      if (/你好|hello/i.test(goal)) return { choices: [{ message: { content: "你好！有什么我可以帮你的吗？" } }] };
      const selected = mainAgentTools.find((entry) => /搜索/.test(entry.function?.description || "")) || mainAgentTools[0];
      const name = this.disableKnownCapability ? "operate_page" : selected.function.name;
      const args = this.disableKnownCapability ? { objective: goal } : { keyword: "lamp" };
      return { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: `main_${modelIndex}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] };
    }
    return { choices: [{ message: { content } }] };
  }
}

function json(body, status = 200) { return { status, contentType: "application/json", headers: { "access-control-allow-origin": "*", "cache-control": "no-store" }, body: JSON.stringify(body) }; }

async function installRoutes(context, plane) {
  await context.route(`${CONTROL_ORIGIN}/**`, async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname; const body = request.postData() ? JSON.parse(request.postData()) : {};
    try {
      if (path === "/sitewake.js") return route.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: sdk });
      if (path === "/sitewake-adaptive.js") return route.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: adaptiveSdk });
      if (path === "/api/site-agents/runtime-lab/release") { plane.timestamp("SDK release loaded"); return route.fulfill(json({ release: plane.release })); }
      if (path === "/api/site-agents/runtime-lab/connection") { plane.timestamp("SDK bootstrap connected"); return route.fulfill(json({ connection: {}, release: plane.release })); }
      if (path === "/api/site-agents/runtime-lab/task-launches/launch_nav/claim" && request.method() === "POST") {
        if (body.token !== "launch_nav.token" || body.origin !== SITE_ORIGIN) return route.fulfill(json({ error: "task_launch_token_rejected" }, 403));
        plane.navClaimKey = body.claimKey;
        return route.fulfill(json({ launch: plane.taskLaunch, claimKey: body.claimKey }));
      }
      if (path === "/api/site-agents/runtime-lab/task-launches/launch_hash/claim" && request.method() === "POST") {
        plane.launchClaims += 1;
        if (body.token !== "launch_hash.token" || body.origin !== SITE_ORIGIN) return route.fulfill(json({ error: "task_launch_token_rejected" }, 403));
        plane.hashClaimKey = body.claimKey;
        return route.fulfill(json({ launch: plane.hashTaskLaunch, claimKey: body.claimKey }));
      }
      if (path === "/api/site-agents/runtime-lab/task-launches/launch_hash" && request.method() === "PATCH") {
        if (!plane.hashClaimKey || body.claimKey !== plane.hashClaimKey) return route.fulfill(json({ error: "task_launch_claim_rejected" }, 403));
        plane.launchPatches.push(body);
        return route.fulfill(json({ launch: { ...plane.hashTaskLaunch, status: body.status || "running" } }));
      }
      if (path === "/api/site-agents/runtime-lab/task-launches/launch_nav" && request.method() === "PATCH") {
        if (!plane.navClaimKey || body.claimKey !== plane.navClaimKey) return route.fulfill(json({ error: "task_launch_claim_rejected" }, 403));
        plane.launchPatches.push({ launchId: "launch_nav", ...body });
        return route.fulfill(json({ launch: { ...plane.taskLaunch, status: body.status || "running" } }));
      }
      if (path === "/api/agent-runs" && request.method() === "POST") return route.fulfill(json(plane.create(body), 201));
      const runMatch = path.match(/^\/api\/agent-runs\/([^/]+)(?:\/(.+))?$/);
      if (runMatch) {
        const [, runId, action] = runMatch; const token = request.headers().authorization?.replace(/^Bearer\s+/i, "") || body.token;
        if (!action && request.method() === "GET") return route.fulfill(json({ run: plane.runView(plane.authorize(runId, token).run), persistence: "memory" }));
        if (!action && request.method() === "PATCH") return route.fulfill(json(plane.finish(runId, token, body)));
        if (action === "handoff") return route.fulfill(json(plane.handoff(runId, token, body)));
        if (action === "ports/claim") return route.fulfill(json(plane.claim(runId, body)));
        if (action === "observations") return route.fulfill(json(plane.checkpoint(runId, token, body)));
        if (action === "cancel") return route.fulfill(json(plane.cancel(runId, token)));
        if (action === "events") return route.fulfill(json({ events: plane.events, persistence: "memory" }));
      }
      if (path === "/api/site-agents/runtime-lab/model/v2/chat/completions") {
        // Like the real proxy: a model request is charged to the run its bearer
        // token names, and a terminal run (stopped, failed) cannot consume any.
        const bearer = request.headers().authorization?.replace(/^Bearer\s+/i, "") || "";
        const owner = [...plane.runs.values()].find((entry) => entry.token === bearer);
        if (owner && ["cancelled", "failed", "completed"].includes(owner.run.status)) return route.fulfill(json({ error: { code: "agent_run_model_budget_terminal" } }, 409));
        return route.fulfill(json(await plane.model(body)));
      }
      if (path === "/api/site-agents/runtime-lab/episodes") { plane.episodes += 1; plane.episodeBodies.push(body); return route.fulfill(json({ release: plane.release, directive: { type: "none" } }, 202)); }
      if (path.includes("/sessions")) {
        if (request.method() === "PATCH") plane.sessionPatches.push(body);
        return route.fulfill(json({ session: { id: body.id || "session", siteAgentId: "runtime-lab", status: body.status || "running", checkpoint: body.checkpoint } }));
      }
      return route.fulfill(json({ error: `unhandled:${path}` }, 404));
    } catch (error) { return route.fulfill(json({ error: error instanceof Error ? error.message : String(error) }, 409)); }
  });
  await context.route(`${SITE_ORIGIN}/**`, async (route) => {
    plane.timestamp(`document ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 200, contentType: "text/html", body: htmlFor(route.request().url()) });
  });
}

async function waitForTerminal(plane, timeout = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const run = [...plane.runs.values()].at(-1)?.run;
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("agent_lab_terminal_timeout");
}

async function recordArtifacts(name, plane, page) {
  await mkdir(artifactsDirectory, { recursive: true });
  const widget = await page.evaluate(() => {
    const root = document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot;
    return { messages: root?.querySelector(".messages")?.textContent, traceCount: root?.querySelectorAll("details.run-trace").length };
  }).catch(() => undefined);
  const payload = { widget, name, modelCalls: plane.modelCalls.length, handoffs: plane.handoffs, claims: plane.claims, checkpointWrites: plane.checkpointWrites, contextSnapshots: plane.contextSnapshots, events: plane.events, runs: [...plane.runs.values()].map((entry) => entry.run) };
  await writeFile(`${artifactsDirectory}/${name}.json`, JSON.stringify(payload, null, 2));
  if (traceEnabled) await page.screenshot({ path: `${artifactsDirectory}/${name}.png` }).catch(() => undefined);
}

function labTest(name, options, body) {
  const skip = requestedCase && !name.includes(requestedCase);
  return test(name, { ...options, skip }, body);
}

async function withLab(name, body) {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // The virtual lab intentionally uses HTTP origins so no real site is involved.
  // Chromium does not expose crypto.randomUUID in that context, while the SDK
  // correctly uses it in production HTTPS pages.
  await context.addInitScript(() => {
    if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: {} });
    if (!globalThis.crypto.randomUUID) {
      globalThis.crypto.randomUUID = () => `lab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  });
  if (traceEnabled) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const plane = new ControlPlane(); const page = await context.newPage(); await installRoutes(context, plane);
  try { return await body({ browser, context, page, plane }); }
  finally {
    await recordArtifacts(name, plane, page);
    if (traceEnabled) await context.tracing.stop({ path: `${artifactsDirectory}/${name}.zip` });
    await browser.close();
  }
}

labTest("known-capability-cross-page: keeps task context and uses exactly two model calls", { timeout: 30_000 }, async () => {
  await withLab("known-capability-cross-page", async ({ page, plane }) => {
    await page.goto(`${SITE_ORIGIN}/`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("查找 lamp"));
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    assert.equal(plane.modelCalls.length, 2, "known capability must be router + final answer only");
    assert.doesNotMatch(JSON.stringify(plane.modelCalls[0]), /慢操作/, "known-capability routing must not force a full page observation");
    assert.match(JSON.stringify(plane.modelCalls[1]), /7/, "the final model turn must consume the structured capability receipt");
    assert.equal(plane.handoffs, 1); assert.equal(plane.claims, 1);
    assert.equal(plane.contextSnapshots.length, 3, "navigation requires before, after-claim and first-directive context snapshots");
    assert.equal(hash(plane.contextSnapshots[0].stable), hash(plane.contextSnapshots[1].stable), "task context must survive the BrowserPort replacement");
    assert.equal(hash(plane.contextSnapshots[1].stable), hash(plane.contextSnapshots[2].stable), "the first destination directive must see the same task context");
    assert.notEqual(hash(plane.contextSnapshots[0].page), hash(plane.contextSnapshots[1].page), "page context must change after navigation");
    assert.equal(run.output.count, 7);
    await page.waitForFunction(() => document.body.innerText.includes("找到") || document.body.innerText.includes("7"));
    assert.match(await page.locator("body").innerText(), /7/);
  });
});

labTest("compact-routing: a keyword task uses the verified entry without capability or knowledge search", { timeout: 30_000 }, async () => {
  await withLab("compact-routing", async ({ page, plane }) => {
    plane.release.profile = {
      ...plane.release.profile,
      suggestedGoals: ["查看历史日榜", "关键词搜索历史热搜"],
      taskTemplates: [{
        id: "task-keyword", name: "关键词搜索历史热搜", description: "按关键词搜索历史记录",
        goalTemplate: "搜索关键词 {keyword} 的历史记录",
        requiredInputs: [{ id: "keyword", name: "关键词", type: "string", prompt: "请输入关键词" }],
        confidence: 0.95,
      }],
    };
    plane.release.scenes[1] = {
      ...plane.release.scenes[1],
      name: "关键词搜索结果",
      description: "按关键词搜索历史记录",
    };
    plane.release.capabilities = [{
      ...plane.release.capabilities[0],
      id: "capability-daily",
      name: "查看每日榜单",
      description: "按日期查看每日榜单",
      normalizedGoal: "查看每日榜单",
      goalTemplate: "查看 {date} 的每日榜单",
      aliases: ["查看历史日榜"],
      inputs: { type: "object", properties: { date: { type: "string", format: "date", examples: ["2025-04-24"] } }, required: ["date"] },
    }];
    plane.mainPlan = [{
      choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{
        id: "route_keyword", type: "function",
        function: { name: "operate_page", arguments: JSON.stringify({ objective: "搜索关键词 lamp 的历史记录" }) },
      }] } }],
    }];
    plane.adaptivePlan = [
      { navigate_scene: { sceneId: "scene-results", bindings: { keyword: "lamp" } } },
      { done: { text: "已找到 lamp 的 7 条结果。", success: true, outcome: "success", output: { keyword: "lamp", count: 7 } } },
    ];
    await page.goto(`${SITE_ORIGIN}/`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    void page.evaluate(() => window.SiteWake.run("搜一下 lamp 的历史记录")).catch(() => undefined);
    await page.waitForURL(`${SITE_ORIGIN}/results/lamp`);
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    assert.equal(plane.modelCalls.length, 3, "the main Agent selects page operation, then PageAgent enters the verified scene and reads the destination");
    const destinationPayload = plane.modelCalls.at(-1);
    const toolNames = destinationPayload.tools.map((entry) => entry.function?.name);
    assert.ok(!toolNames.includes("search_capabilities"), "the full public catalog is already present");
    assert.ok(!toolNames.includes("search_site_knowledge"), "the verified keyword entry is already in routing context");
    assert.doesNotMatch(JSON.stringify(plane.modelCalls[0]), /2025-04-24/, "unrelated capability schema examples are not sent to the main Agent");
    assert.equal(run.activityTimeline.filter((item) => item.kind === "knowledge" || item.kind === "capability").length, 0,
      "the verified Scene is used directly without capability or knowledge lookup");
    assert.equal(plane.handoffs, 1);
    assert.equal(new URL(page.url()).pathname, "/results/lamp");
    const widget = await page.evaluate(() => document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot?.querySelector(".panel")?.textContent || "");
    assert.doesNotMatch(widget, /搜索已发布能力|查询网站知识/);
    assert.match(widget, /关键词搜索结果|lamp/);
  });
});

labTest("conversation-greeting: answers in one model turn without capabilities or page observation", { timeout: 30_000 }, async () => {
  await withLab("conversation-greeting", async ({ page, plane }) => {
    await page.goto(`${SITE_ORIGIN}/`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("你好"));
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    assert.equal(plane.modelCalls.length, 1, "a greeting is one main-Agent turn");
    assert.equal(plane.handoffs, 0);
    assert.equal(plane.checkpointWrites, 0, "a greeting must not capture or checkpoint page evidence");
    assert.equal(plane.episodes, 0, "a greeting must not enter capability learning as an adaptive episode");
    assert.match(run.conversation.at(-1)?.content || "", /你好/);
    const body = await page.locator("body").innerText();
    assert.doesNotMatch(body, /理解需求并选择工具|任务已完成/, "direct chat shows neither a fake tool trace nor task-complete copy");
    assert.equal(plane.modelCalls[0].tools.filter((entry) => entry.function?.name?.startsWith("capability_")).length > 0, true, "published capabilities are registered as ordinary tools");
  });
});

labTest("knowledge-lookup-loop: an unknown task searches knowledge once without duplicating the customer trace", { timeout: 30_000 }, async () => {
  await withLab("knowledge-lookup-loop", async ({ page, plane }) => {
    plane.mainPlan = [
      { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "knowledge_1", type: "function", function: { name: "search_site_knowledge", arguments: JSON.stringify({ query: "站外结算规则" }) } }] } }] },
      { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "knowledge_2", type: "function", function: { name: "search_site_knowledge", arguments: JSON.stringify({ query: "站外结算规则" }) } }] } }] },
      { choices: [{ message: { content: "已根据网站知识整理站外结算规则。" } }] },
    ];
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake)); await page.evaluate(() => window.SiteWake.open());
    await page.evaluate(() => window.SiteWake.run("了解站外结算规则")).catch(() => undefined);
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    assert.equal(plane.modelCalls.length, 3, "the repeated lookup is rejected immediately, followed by a grounded main-Agent answer");
    assert.doesNotMatch(run.outcome?.summary || "", /main_agent_turn_limit/);
    assert.equal(run.activityTimeline.filter((item) => item.kind === "knowledge").length, 1, "a repeated lookup is rejected before another search runs");
    assert.equal(plane.checkpointWrites, 0, "an informational lookup loop must not start PageAgent");
    assert.equal(plane.episodes, 0, "an informational lookup loop must not create an adaptive learning episode");
    const widget = await page.evaluate(() => document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot?.querySelector(".panel")?.textContent || "");
    assert.match(widget, /查询网站知识/, "the one real knowledge lookup remains visible as a tool receipt");
  });
});

labTest("effectful-knowledge-paraphrase-fallback: a second rewritten knowledge query starts PageAgent instead of exhausting main-Agent turns", { timeout: 30_000 }, async () => {
  await withLab("effectful-knowledge-paraphrase-fallback", async ({ page, plane }) => {
    const goal = "找到休闲椅帮我加入购物车";
    plane.mainPlan = [
      { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "knowledge_chair", type: "function", function: { name: "search_site_knowledge", arguments: JSON.stringify({ query: "休闲椅" }) } }] } }] },
      { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "knowledge_moss", type: "function", function: { name: "search_site_knowledge", arguments: JSON.stringify({ query: "Moss 休闲椅商品详情" }) } }] } }] },
    ];
    plane.adaptivePlan = [
      { click_element_by_index: { index: 6 } },
      { done: {
        text: "已将 Moss 休闲椅加入购物车。", success: true, outcome: "success", output: { cartItem: "Moss 休闲椅" },
        completionEvidence: [
          { criterion: `Complete the user's original objective: ${goal}`, evidence: "Moss 休闲椅" },
          { criterion: "Observe a page or business receipt that proves the requested change took effect.", evidence: "已加入购物车" },
        ],
      } },
    ];
    await page.goto(`${SITE_ORIGIN}/`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate((taskGoal) => window.SiteWake.run(taskGoal), goal).catch(() => undefined);
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    assert.equal(plane.modelCalls.length, 4, "two Main Agent turns plus one material action and one evidenced PageAgent completion are sufficient");
    assert.equal(run.activityTimeline.filter((item) => item.kind === "knowledge").length, 1, "the rewritten second query is rejected before another retrieval runs");
    assert.doesNotMatch(run.outcome?.summary || "", /main_agent_turn_limit/);
    assert.match(run.outcome?.summary || "", /Moss|购物车/);
  });
});

labTest("effectful-scene-candidate-fallback: navigate_scene cannot terminate a task that still requires a page effect", { timeout: 30_000 }, async () => {
  await withLab("effectful-scene-candidate-fallback", async ({ page, plane }) => {
    const goal = "把 Moss 休闲椅加入购物车";
    plane.mainPlan = [
      { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "knowledge_scene", type: "function", function: { name: "search_site_knowledge", arguments: JSON.stringify({ query: "Moss 休闲椅" }) } }] } }] },
      { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "candidate_scene", type: "function", function: { name: "navigate_scene", arguments: JSON.stringify({ sceneId: "scene-results", bindings: { keyword: "Moss" } }) } }] } }] },
    ];
    plane.adaptivePlan = [
      { click_element_by_index: { index: 6 } },
      { done: {
        text: "已将 Moss 休闲椅加入购物车。", success: true, outcome: "success", output: { cartItem: "Moss 休闲椅" },
        completionEvidence: [
          { criterion: `Complete the user's original objective: ${goal}`, evidence: "Moss 休闲椅" },
          { criterion: "Observe a page or business receipt that proves the requested change took effect.", evidence: "已加入购物车" },
        ],
      } },
    ];
    await page.goto(`${SITE_ORIGIN}/`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate((taskGoal) => window.SiteWake.run(taskGoal), goal).catch(() => undefined);
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    assert.equal(plane.modelCalls.length, 4, "the scene candidate hands control to a material PageAgent action and evidenced completion");
    assert.equal(plane.claims, 0, "the material same-page action must not turn into a document navigation");
    assert.equal(new URL(page.url()).pathname, "/");
    assert.equal(run.outcome?.evidence?.actions, 1, "the effectful task must be grounded by a material page action");
    assert.match(run.outcome?.summary || "", /Moss|购物车/);
  });
});

labTest("informational-paraphrases-stay-in-main-agent: multiple knowledge queries can still end in a grounded text answer", { timeout: 30_000 }, async () => {
  await withLab("informational-paraphrases-stay-in-main-agent", async ({ page, plane }) => {
    plane.mainPlan = [
      { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "policy_1", type: "function", function: { name: "search_site_knowledge", arguments: JSON.stringify({ query: "退货政策" }) } }] } }] },
      { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "policy_2", type: "function", function: { name: "search_site_knowledge", arguments: JSON.stringify({ query: "退款规则说明" }) } }] } }] },
      { choices: [{ message: { content: "退货政策以商品页面公示规则为准。" } }] },
    ];
    await page.goto(`${SITE_ORIGIN}/`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("请问退货政策是什么")).catch(() => undefined);
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    assert.equal(plane.modelCalls.length, 3);
    assert.equal(plane.checkpointWrites, 0, "an informational answer must not start PageAgent");
    assert.equal(plane.episodes, 0, "an informational answer must not create an adaptive learning episode");
    assert.match(run.conversation.at(-1)?.content || "", /退货政策/);
  });
});

labTest("compound-navigation-effects-start-page-agent: opening a page cannot hide the requested cart or checkout effect", { timeout: 30_000 }, async () => {
  for (const [index, goal] of ["打开商品页面并加入购物车", "打开购物车并结算"].entries()) {
    await withLab(`compound-navigation-effects-start-page-agent-${index}`, async ({ page, plane }) => {
      plane.mainPlan = [{ choices: [{ message: { content: "已打开目标页面。" } }] }];
      const checkout = index === 1;
      plane.adaptivePlan = [
        { click_element_by_index: { index: checkout ? 7 : 6 } },
        { done: {
          text: `已执行：${goal}`, success: true, outcome: "success", output: { effectApplied: true },
          completionEvidence: [
            { criterion: `Complete the user's original objective: ${goal}`, evidence: checkout ? "订单结算" : "Moss 休闲椅" },
            { criterion: "Observe a page or business receipt that proves the requested change took effect.", evidence: checkout ? "已提交" : "已加入购物车" },
          ],
        } },
      ];
      await page.goto(`${SITE_ORIGIN}/`);
      await page.waitForFunction(() => Boolean(window.SiteWake));
      await page.evaluate((taskGoal) => window.SiteWake.run(taskGoal), goal).catch(() => undefined);
      const run = await waitForTerminal(plane);
      assert.equal(run.status, "completed", goal);
      assert.equal(plane.modelCalls.length, 3, `${goal} must use a material PageAgent action after the ungrounded main-Agent reply`);
      assert.equal(plane.episodes, 1, `${goal} must produce an adaptive execution episode`);
      assert.equal(run.output?.effectApplied, true);
    });
  }
});

labTest("informational-effect-words-stay-main-agent: how-to wording never mutates the page", { timeout: 30_000 }, async () => {
  const goals = ["请问如何加入购物车", "我需要了解登录流程", "How do I add this to cart?"];
  for (const [index, goal] of goals.entries()) {
    await withLab(`informational-effect-words-stay-main-agent-${index}`, async ({ page, plane }) => {
      plane.mainPlan = [{ choices: [{ message: { content: `这是关于“${goal}”的操作说明。` } }] }];
      await page.goto(`${SITE_ORIGIN}/`);
      await page.waitForFunction(() => Boolean(window.SiteWake));
      await page.evaluate((taskGoal) => window.SiteWake.run(taskGoal), goal).catch(() => undefined);
      const run = await waitForTerminal(plane);
      assert.equal(run.status, "completed", goal);
      assert.equal(plane.modelCalls.length, 1, `${goal} must remain a main-Agent answer`);
      assert.equal(plane.checkpointWrites, 0, `${goal} must not start PageAgent`);
      assert.equal(plane.episodes, 0, `${goal} must not create an adaptive episode`);
    });
  }
});

labTest("main-agent-turn-limit-failure: exhaustion exposes a safe reason and preserves the raw terminal evidence", { timeout: 30_000 }, async () => {
  await withLab("main-agent-turn-limit-failure", async ({ page, plane }) => {
    plane.mainPlan = Array.from({ length: 4 }, (_, index) => ({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: `capability_search_${index}`, type: "function", function: { name: "search_capabilities", arguments: JSON.stringify({ query: `退货规则 ${index}` }) } }] } }] }));
    await page.goto(`${SITE_ORIGIN}/`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("查询退货规则")).catch(() => undefined);
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "failed");
    assert.equal(run.outcome?.code, "main_agent_routing_exhausted");
    assert.match(run.outcome?.summary || "", /未能在本次轮次内确定执行路径/);
    assert.equal(run.outcome?.evidence?.runtimeError, "main_agent_turn_limit");
    assert.equal(plane.checkpointWrites, 0, "turn exhaustion for an informational goal must not start PageAgent");
    assert.equal(plane.sessionPatches.at(-1)?.status, "failed");
  });
});

labTest("scene-routing-failure: a navigation-only failure is explicit and closes both runtime projections", { timeout: 30_000 }, async () => {
  await withLab("scene-routing-failure", async ({ page, plane }) => {
    plane.mainPlan = Array.from({ length: 4 }, (_, index) => ({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: `missing_scene_${index}`, type: "function", function: { name: "navigate_scene", arguments: JSON.stringify({ sceneId: `missing-${index}`, bindings: {} }) } }] } }] }));
    await page.goto(`${SITE_ORIGIN}/`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("打开不存在的页面")).catch(() => undefined);
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "failed");
    assert.equal(run.outcome?.code, "main_agent_scene_route_failed");
    assert.match(run.outcome?.summary || "", /页面入口不可直接使用/);
    assert.match(run.outcome?.evidence?.runtimeError || "", /main_agent_scene_route_failed:scene_direct_entry_unverified/);
    assert.equal(plane.checkpointWrites, 0, "a rejected navigation candidate must not start PageAgent");
    assert.equal(plane.sessionPatches.at(-1)?.status, "failed", "the legacy learning projection must not remain running");
  });
});

labTest("trusted-legacy-navigation-handoff: a claimed task resolves the transient adapter without catalog persistence", { timeout: 30_000 }, async () => {
  await withLab("trusted-legacy-navigation-handoff", async ({ page, plane }) => {
    assert.equal(plane.release.capabilities.some((item) => item.id.startsWith("navigation-tool:") || item.id.startsWith("capability_shared_nav_")), false);
    await page.goto(`${SITE_ORIGIN}/#sitewake-launch=launch_nav.token`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed"); assert.equal(run.output.count, 7);
    assert.equal(plane.modelCalls.length, 0, "direct function calls must stay model-free");
    assert.equal(plane.handoffs, 1); assert.equal(plane.claims, 1);
    assert.equal(plane.contextSnapshots[0].stable.programCursor.programStepIndex, 1);
    assert.equal(plane.contextSnapshots[1].stable.programCursor.programStepIndex, 1);
  });
});

labTest("unpinned-claimed-capability: an invalid legacy claim reports a terminal failure instead of hanging", { timeout: 30_000 }, async () => {
  await withLab("unpinned-claimed-capability", async ({ page, plane }) => {
    delete plane.taskLaunch.releaseId;
    delete plane.taskLaunch.releaseVersion;
    delete plane.taskLaunch.revisionId;
    await page.goto(`${SITE_ORIGIN}/#sitewake-launch=launch_nav.token`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    const deadline = Date.now() + 8_000;
    while (!plane.launchPatches.some((patch) => patch.status === "failed") && Date.now() < deadline) {
      await page.waitForTimeout(25);
    }
    const terminal = plane.launchPatches.find((patch) => patch.status === "failed");
    assert.ok(terminal, "the claimed launch must receive a terminal PATCH");
    assert.equal(terminal.error?.code, "task_launch_execution_pin_incomplete");
    assert.equal(plane.runs.size, 0, "an unpinned capability must never create an AgentRun");
  });
});

labTest("hash-router-launch-transport: a router mounted before the SDK renders the restored route and claims once", { timeout: 30_000 }, async () => {
  await withLab("hash-router-launch-transport", async ({ page, plane }) => {
    for (const [name, bundle] of [["sitewake.js", sdk]]) {
      assert.match(bundle, /HashChangeEvent/, `${name} must notify native hash routers after restoring the return hash`);
      assert.match(bundle, /PopStateEvent/, `${name} must notify history-based routers after restoring the return hash`);
    }
    const transportHash = new URLSearchParams({
      "sitewake-launch": "launch_hash.token",
      "sitewake-return-hash": "/cart",
    });
    await page.goto(`${SITE_ORIGIN}/hash-router#${transportHash}`);
    await page.waitForFunction(() => (
      location.hash === "#/cart"
      && document.querySelector("#hash-route")?.textContent === "cart"
      && Boolean(window.SiteWake)
    ));
    const deadline = Date.now() + 8_000;
    while ((!plane.launchClaims || !plane.launchPatches.length) && Date.now() < deadline) {
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(200);

    assert.equal(new URL(page.url()).hash, "#/cart");
    assert.equal(await page.locator("#hash-route").textContent(), "cart");
    assert.equal(plane.launchClaims, 1, "restoring the application hash must not claim the launch twice");
    assert.ok(plane.launchPatches.length >= 1, "requests after the claim remain observable by the mocked control plane");
    const routeEvents = await page.evaluate(() => window.__hashRouteEvents);
    assert.ok(routeEvents.some((event) => event.type === "hashchange" && event.route === "cart"),
      `the pre-mounted hash listener must observe the restored route: ${JSON.stringify(routeEvents)}`);
    assert.ok(routeEvents.some((event) => event.type === "popstate" && event.route === "cart"),
      `history-based routers must observe the restored route: ${JSON.stringify(routeEvents)}`);
  });
});

labTest("public-navigation-tool-id-is-denied: a terminal caller cannot bypass Capability exposure with a technical id", { timeout: 30_000 }, async () => {
  await withLab("public-navigation-tool-id-is-denied", async ({ page, plane }) => {
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
    const error = await page.evaluate(() => window.SiteWake.call("navigation-tool:click")
      .then(() => "", (reason) => reason instanceof Error ? reason.message : String(reason)));
    assert.equal(error, "capability_not_available");
    assert.equal(plane.runs.size, 0, "a denied technical id must not create an AgentRun");
    assert.equal(plane.handoffs, 0);
  });
});

labTest("internal-navigation-fast-path: an unambiguous page command invokes the verified internal tool, preserves the transcript, and completes after handoff", { timeout: 30_000 }, async () => {
  await withLab("internal-navigation-fast-path", async ({ page, plane }) => {
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake)); await page.evaluate(() => window.SiteWake.open());
    await page.evaluate(() => window.SiteWake.run("打开搜索结果页面"));
    await page.waitForFunction(() => location.pathname === "/results/lamp");
    await page.waitForFunction(() => Boolean(window.SiteWake));
    const restored = await page.evaluate(() => document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot?.textContent || "");
    assert.match(restored, /打开搜索结果页面/, "the destination BrowserPort restores the user turn before execution completes");
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    assert.equal(plane.modelCalls.length, 0, "a zero-input verified navigation is a direct tool call, not a routing or knowledge-model turn");
    assert.equal(plane.handoffs, 1); assert.equal(plane.claims, 1);
    assert.match(run.conversation.map((item) => item.content).join("\n"), /打开搜索结果页面/);
    assert.equal(run.outcome?.status, "success");
    // Starting the next turn must not erase the earlier completed capability
    // card. It is part of the conversation's recoverable run history.
    await page.evaluate(() => window.SiteWake.run("你好"));
    const afterNextTurn = await page.evaluate(() => document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot?.textContent || "");
    assert.match(afterNextTurn, /导航工具|页面导航|Navigation/);
    assert.match(afterNextTurn, /打开搜索结果/);
    const messageOrder = await page.evaluate(() => {
      const root = document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot;
      return [...(root?.querySelector(".messages")?.children || [])].map((node) => ({
        kind: node.className,
        text: (node.textContent || "").slice(0, 120),
      }));
    });
    const traceIndex = messageOrder.findIndex((item) => item.kind === "run-trace");
    const latestAssistantIndex = messageOrder.findLastIndex((item) => item.kind.includes("message-row assistant"));
    assert.ok(traceIndex >= 0 && latestAssistantIndex >= 0 && traceIndex < latestAssistantIndex,
      `the completed capability trace stays in the transcript before the later conversational reply: ${JSON.stringify(messageOrder)}`);
  });
});

labTest("new-conversation-boundary: explicitly starting a new chat clears old invocation cards and cannot resurrect them", { timeout: 30_000 }, async () => {
  await withLab("new-conversation-boundary", async ({ page, plane }) => {
    await page.goto(`${SITE_ORIGIN}/results/lamp`); await page.waitForFunction(() => Boolean(window.SiteWake)); await page.evaluate(() => window.SiteWake.open());
    await page.evaluate(() => window.SiteWake.call("capability-search", { keyword: "lamp" }));
    await waitForTerminal(plane);
    await page.waitForFunction(() => Boolean(document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot?.querySelector(".new-chat")));
    await page.evaluate(() => document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot?.querySelector(".new-chat")?.click());
    await page.waitForFunction(() => {
      const root = document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot;
      return !root?.textContent?.includes("打开搜索结果页面") && !root?.querySelector(".capability-call");
    });
    await page.reload(); await page.waitForFunction(() => Boolean(window.SiteWake));
    const restored = await page.evaluate(() => {
      const root = document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot;
      return { cards: root?.querySelectorAll(".capability-call").length || 0, messages: root?.querySelectorAll(".message-row").length || 0 };
    });
    assert.deepEqual(restored, { cards: 0, messages: 0 }, "a hard conversation reset must clear both transcript and capability projection across refresh");
  });
});

labTest("parameterized-business-goal: internal navigation cannot masquerade as a completed search", { timeout: 30_000 }, async () => {
  await withLab("parameterized-business-goal", async ({ page, plane }) => {
    plane.mainPlan = [{ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "search_zhou", type: "function", function: { name: "capability_1", arguments: JSON.stringify({ keyword: "周杰伦" }) } }] } }] }];
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("搜索周杰伦的热搜")).catch(() => undefined);
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    const invocationSnapshot = plane.contextSnapshots.find((snapshot) => snapshot.stable.capabilityInvocation?.input?.keyword);
    assert.equal(invocationSnapshot?.stable.capabilityInvocation?.input?.keyword, "周杰伦");
    assert.match(run.output.pageUrl || run.activePort?.url || page.url(), /%E5%91%A8%E6%9D%B0%E4%BC%A6|周杰伦/);
    const advertised = plane.modelCalls[0].tools.filter((entry) => entry.function?.name?.startsWith("capability_")).map((entry) => entry.function.description);
    assert.equal(advertised.length, 1, "only the public business capability is a top-level Agent tool");
    assert.doesNotMatch(advertised.join("\n"), /打开搜索结果|导航/, "internal navigation remains an implementation asset");
  });
});

labTest("formal-navigation-legacy-release: optional legacy presentation fields cannot crash runtime dispatch", { timeout: 30_000 }, async () => {
  await withLab("formal-navigation-legacy-release", async ({ page, plane }) => {
    const navigation = plane.release.capabilities.find((item) => item.id === "capability-open-results");
    // Releases created before the current canonicalizer may omit optional
    // aliases/goalTemplate fields. Runtime dispatch must skip absent phrases
    // rather than throwing before the first activity can be recorded.
    delete navigation.goalTemplate; delete navigation.aliases;
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("打开搜索结果页面"));
    await page.waitForFunction(() => location.pathname === "/results/lamp");
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    assert.equal(plane.modelCalls.length, 0);
    assert.equal(plane.handoffs, 1);
  });
});

labTest("runtime-release-reset: the server replaces a higher-version browser cache", { timeout: 30_000 }, async () => {
  await withLab("runtime-release-reset", async ({ page, plane }) => {
    const staleRelease = structuredClone(plane.release);
    staleRelease.id = "runtime-lab:release:29";
    staleRelease.version = 29;
    staleRelease.capabilities = staleRelease.capabilities.map((capability) => ({
      ...capability,
      id: `stale-${capability.id}`,
    }));
    await page.addInitScript((release) => {
      localStorage.setItem("sitewake:v5:runtime-lab:release", JSON.stringify(release));
    }, staleRelease);

    await page.goto(`${SITE_ORIGIN}/`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    const loaded = await page.evaluate(() => window.SiteWake.getRelease());

    assert.equal(loaded.id, plane.release.id);
    assert.equal(loaded.version, plane.release.version);
    assert.deepEqual(
      loaded.capabilities.map((capability) => capability.id),
      plane.release.capabilities.map((capability) => capability.id),
      "a clean server restore cannot leave stale Capability ids painted from a higher cache version",
    );
  });
});

labTest("refresh-cancellation: a manual refresh without a handoff token never resumes", { timeout: 30_000 }, async () => {
  await withLab("refresh-does-not-resume", async ({ page, plane }) => {
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => {
      sessionStorage.setItem("sitewake:v5:runtime-lab:run", JSON.stringify({ runId: "run_abandoned", resumeToken: "run_abandoned.token", revision: 1, pageEpoch: 1, savedAt: Date.now() }));
      sessionStorage.setItem("sitewake:v5:runtime-lab:checkpoint", JSON.stringify({ sessionId: "run_abandoned", mode: "compiled", phase: "running", input: {}, operationIndex: 0, programStepIndex: 0, savedAt: Date.now() }));
    });
    const callsBefore = plane.modelCalls.length;
    await page.reload(); await page.waitForTimeout(300);
    assert.equal(plane.modelCalls.length, callsBefore, "reload must not restart the abandoned Agent task");
    assert.equal(plane.runs.size, 0, "reload must not create a replacement run");
  });
});

labTest("explicit-cancellation: a stopped run cannot regain control after reload", { timeout: 30_000 }, async () => {
  await withLab("explicit-cancellation", async ({ page, plane }) => {
    plane.modelDelayMs = 250;
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => { void window.SiteWake.run("查找 lamp"); });
    await page.waitForTimeout(40);
    await page.evaluate(() => window.SiteWake.cancel());
    await page.reload();
    await page.waitForTimeout(350);
    const run = [...plane.runs.values()][0]?.run;
    assert.equal(run?.status, "cancelled");
    assert.equal(plane.handoffs, 0, "a cancelled task must not navigate later");
    assert.equal(plane.claims, 0, "a cancelled task must not claim a new BrowserPort");
  });
});

labTest("invalid-target: a missing or invalid control never becomes a successful page action", { timeout: 30_000 }, async () => {
  await withLab("invalid-target", async ({ page, plane }) => {
    const operation = plane.release.operations.find((item) => item.id === "operation-click");
    operation.implementations[0].program.steps[0].targetId = "target-does-not-exist";
    await page.goto(`${SITE_ORIGIN}/#sitewake-launch=launch_nav.token`); await page.waitForFunction(() => Boolean(window.SiteWake));
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "failed");
    assert.equal(plane.handoffs, 0, "a failed click must never trigger a navigation handoff");
    assert.match(run.outcome?.summary || "", /target|目标|not_found/i);
  });
});

labTest("page-agent-smoke: an unknown goal loads the exploratory bundle and returns a final answer", { timeout: 30_000 }, async () => {
  await withLab("page-agent-smoke", async ({ page, plane }) => {
    plane.disableKnownCapability = true;
    plane.adaptivePlan = [{ click_element_by_index: { index: 3 } }, { done: { text: "已到达搜索结果页，找到 7 条结果。", success: true, outcome: "success", output: { count: 7 } } }];
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("探索当前页面")).catch(() => undefined);
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    assert.equal(plane.handoffs, 1);
    assert.equal(plane.claims, 1);
    assert.equal(plane.modelCalls.length, 3, "router + one PageAgent turn per document");
    assert.match(run.conversation.at(-1)?.content || "", /7/);
  });
});

labTest("page-agent-cross-page-feedback: the destination page visibly continues work before its model turn", { timeout: 30_000 }, async () => {
  await withLab("page-agent-cross-page-feedback", async ({ page, plane }) => {
    plane.disableKnownCapability = true;
    plane.modelDelayByCall = { 3: 700 };
    plane.adaptivePlan = [{ click_element_by_index: { index: 3 } }, { done: { text: "已读取结果页并完成。", success: true, outcome: "success", output: { count: 7 } } }];
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.open());
    await page.evaluate(() => window.SiteWake.run("探索当前页面")).catch(() => undefined);
    await page.waitForFunction(() => location.pathname === "/results/lamp");
    await page.waitForTimeout(300);
    const progress = await page.evaluate(() => {
      const root = document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot;
      const node = root?.querySelector(".progress");
      return { exists: Boolean(root), visible: Boolean(node && node.classList && node.classList.contains("show")), text: node?.textContent || "" };
    });
    const agentHosts = await page.evaluate(() => [...document.querySelectorAll("[data-sitewake-agent]")].map((node) => ({ tag: node.tagName, value: node.getAttribute("data-sitewake-agent") })));
    assert.equal(progress.exists, true, `the restored document must mount the persistent Agent UI: ${JSON.stringify(agentHosts)}`);
    assert.equal(progress.visible, true, `the Agent must visibly report restoration work: ${progress.text}`);
    assert.match(progress.text, /恢复任务|读取当前页面内容|读取结果页证据|正在理解你的目标|同步最新能力/,
      "the destination page must expose progress while it restores context, collects evidence, or waits for the model");
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
  });
});

labTest("page-agent-three-documents: continues one unknown-task context without replaying completed steps", { timeout: 30_000 }, async () => {
  await withLab("page-agent-three-documents", async ({ page, plane }) => {
    plane.disableKnownCapability = true;
    plane.adaptivePlan = [
      { click_element_by_index: { index: 3 } },
      { click_element_by_index: { index: 1 } },
      { done: { text: "已打开结果详情。", success: true, outcome: "success", output: { detail: "lamp 的完整结果详情" } } },
    ];
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("打开 lamp 的结果详情")).catch(() => undefined);
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    assert.equal(plane.handoffs, 2, "every document transition must have one atomic handoff");
    assert.equal(plane.claims, 2, "each destination document must claim the same Run");
    assert.equal(plane.modelCalls.length, 4, "router plus exactly one PageAgent turn per document");
    assert.equal(plane.contextSnapshots.length, 6, "each navigation records before/claim/continuation snapshots");
    const stableHashes = plane.contextSnapshots.map((snapshot) => hash(taskInvariant(snapshot)));
    assert.equal(new Set(stableHashes).size, 1, "goal, conversation, trace and receipts cannot be lost across documents");
    const adaptivePrompts = plane.modelCalls.filter((payload) => payload.tools?.some?.((tool) => tool.function?.name === "AgentOutput"));
    assert.match(JSON.stringify(adaptivePrompts.at(-1)), /跨页面恢复|click_element_by_index/, "the last page receives prior action context instead of re-planning from an empty task");
    assert.match(run.conversation.at(-1)?.content || "", /结果详情/);
  });
});

labTest("page-agent-no-result: a legitimate empty result ends once without selector repair", { timeout: 30_000 }, async () => {
  await withLab("page-agent-no-result", async ({ page, plane }) => {
    plane.disableKnownCapability = true;
    plane.adaptivePlan = [
      { done: { text: "没有找到匹配结果。", success: true, outcome: "no-result", output: { count: 0 } } },
    ];
    await page.goto(`${SITE_ORIGIN}/results/none`); await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("检查当前页面是否存在可用库存")).catch(() => undefined);
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed", "no-result is a completed business outcome, not a runtime failure");
    assert.equal(plane.modelCalls.length, 2, "an unknown no-result needs one router and one PageAgent decision only");
    assert.equal(plane.handoffs, 0);
    assert.match(run.outcome?.summary || "", /没有找到/);
  });
});

labTest("page-agent-invalid-click: a non-effective click is never reported as a completed page action", { timeout: 30_000 }, async () => {
  await withLab("page-agent-invalid-click", async ({ page, plane }) => {
    plane.disableKnownCapability = true;
    plane.adaptivePlan = [{ click_element_by_index: { index: 999 } }];
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("点击一个不存在的入口")).catch(() => undefined);
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "failed");
    assert.equal(plane.handoffs, 0);
    assert.doesNotMatch(run.conversation.at(-1)?.content || "", /已完成|成功打开/);
  });
});

labTest("page-agent-cancel-after-handoff: a cancelled exploratory run cannot resume or act after reload", { timeout: 30_000 }, async () => {
  await withLab("page-agent-cancel-after-handoff", async ({ page, plane }) => {
    plane.disableKnownCapability = true;
    plane.modelDelayByCall = { 3: 1_000 };
    plane.adaptivePlan = [{ click_element_by_index: { index: 3 } }, { done: { text: "不应执行", success: true, outcome: "success" } }];
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("取消跨页探索")).catch(() => undefined);
    await page.waitForFunction(() => location.pathname === "/results/lamp");
    const claimDeadline = Date.now() + 8_000;
    while (plane.claims < 1 && Date.now() < claimDeadline) {
      await page.waitForTimeout(25);
    }
    assert.equal(plane.claims, 1, "cancel is issued by the destination BrowserPort after its one-shot claim");
    await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.cancel());
    await page.reload();
    await page.waitForTimeout(1_200);
    const run = [...plane.runs.values()].at(-1)?.run;
    assert.equal(run?.status, "cancelled");
    assert.equal(plane.modelCalls.length, 2, "a reload after cancel must not start another PageAgent turn");
    assert.equal(plane.handoffs, 1);
  });
});

labTest("runtime-benchmark: reports framework overhead separately from model and page time", { timeout: 60_000 }, async () => {
  const measurements = [];
  const samePageMeasurements = [];
  // Keep the smoke-suite threshold meaningful without counting the first
  // browser/JIT cold start as the P95 of a three-sample micro benchmark.
  const warmups = benchmark ? 3 : 1;
  const iterations = benchmark ? 20 : 3;
  for (let index = 0; index < warmups; index += 1) {
    await withLab(`benchmark-warmup-${index}`, async ({ page, plane }) => {
      await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
      await page.evaluate(() => window.SiteWake.run("查找 lamp")); await waitForTerminal(plane);
    });
  }
  for (let index = 0; index < iterations; index += 1) {
    await withLab(`benchmark-${index}`, async ({ page, plane }) => {
      const started = performance.now();
      await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
      await page.evaluate(() => window.SiteWake.run("查找 lamp"));
      await waitForTerminal(plane);
      const named = (name) => plane.events.filter((event) => event.name === name).map((event) => event.at);
      const first = (name) => named(name)[0]; const last = (name) => named(name).at(-1);
      const modelMs = [1, 2].reduce((total, index) => total + Math.max(0, (first(`model ${index} completed`) || 0) - (first(`model ${index} started`) || 0)), 0);
      const handoffAt = first("handoff committed"); const claimAt = first("BrowserPort claimed"); const renderAt = last("result rendered");
      const documents = plane.events.filter((event) => event.name.startsWith("document "));
      const pageLoadMs = Math.max(0, (documents[1]?.at || 0) - handoffAt);
      const totalMs = performance.now() - started;
      measurements.push({
        runCreateMs: first("run created") - started,
        initialModelMs: Math.max(0, (first("model 1 completed") || 0) - (first("model 1 started") || 0)),
        toolDispatchMs: Math.max(0, handoffAt - (first("model 1 completed") || handoffAt)),
        programExecutionMs: Math.max(0, renderAt - handoffAt),
        handoffPrepareMs: 0,
        handoffRequestMs: 0,
        pageLoadMs,
        sdkBootstrapMs: Math.max(0, (last("SDK bootstrap connected") || claimAt) - (documents[1]?.at || claimAt)),
        portClaimMs: Math.max(0, claimAt - (last("SDK bootstrap connected") || claimAt)),
        contextHydrationMs: 0,
        continuationDispatchMs: Math.max(0, renderAt - claimAt),
        finalModelMs: Math.max(0, (first("model 2 completed") || 0) - (first("model 2 started") || 0)),
        resultRenderMs: Math.max(0, totalMs - (renderAt - started)),
        handoffRestoreMs: claimAt - handoffAt,
        frameworkAfterClaimMs: renderAt - claimAt,
        modelMs,
        frameworkOverheadMs: Math.max(0, totalMs - modelMs - pageLoadMs),
        totalMs,
      });
    });
  }
  for (let index = 0; index < iterations; index += 1) {
    await withLab(`same-page-benchmark-${index}`, async ({ page, plane }) => {
      await page.goto(`${SITE_ORIGIN}/results/lamp`); await page.waitForFunction(() => Boolean(window.SiteWake));
      const started = performance.now();
      await page.evaluate(() => window.SiteWake.call("capability-search", { keyword: "lamp" }));
      const run = await waitForTerminal(plane);
      samePageMeasurements.push(performance.now() - started);
      assert.equal(run.output.count, 7);
      assert.equal(plane.modelCalls.length, 0);
      assert.equal(plane.handoffs, 0);
    });
  }
  const sorted = (field) => measurements.map((item) => item[field]).sort((a, b) => a - b);
  const percentile = (values, p) => values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
  const sortedSamePage = [...samePageMeasurements].sort((a, b) => a - b);
  const summary = { iterations, warmups, samePageProgram: { p50Ms: percentile(sortedSamePage, .5), p95Ms: percentile(sortedSamePage, .95), maxMs: Math.max(...sortedSamePage) }, p50: Object.fromEntries(Object.keys(measurements[0]).map((field) => [field, percentile(sorted(field), .5)])), p95: Object.fromEntries(Object.keys(measurements[0]).map((field) => [field, percentile(sorted(field), .95)])), max: Object.fromEntries(Object.keys(measurements[0]).map((field) => [field, Math.max(...sorted(field))])) };
  await mkdir(artifactsDirectory, { recursive: true });
  await writeFile(`${artifactsDirectory}/benchmark-summary.json`, JSON.stringify({ summary, measurements }, null, 2));
  console.log(`Agent Runtime Benchmark ${JSON.stringify(summary)}`);
  // The customer-visible, per-turn business-action card is rendered before
  // this direct call resolves. Keep the local budget tight while allowing the
  // small deterministic DOM cost of that acknowledgement.
  assert.ok(summary.samePageProgram.p95Ms <= 275, `same-page program exceeded local target: ${summary.samePageProgram.p95Ms}ms`);
  assert.ok(summary.p95.handoffRestoreMs <= 300, `cross-page context restoration exceeded local target: ${summary.p95.handoffRestoreMs}ms`);
  assert.ok(summary.p95.totalMs - summary.p95.modelMs <= 1_500, `known capability framework path exceeded local target: ${summary.p95.totalMs - summary.p95.modelMs}ms`);
  assert.ok(summary.p95.handoffRestoreMs <= 750, `handoff restore exceeded CI ceiling: ${summary.p95.handoffRestoreMs}ms`);
  assert.ok(summary.p95.frameworkAfterClaimMs <= 1_500, `post-claim framework work exceeded CI ceiling: ${summary.p95.frameworkAfterClaimMs}ms`);
});

labTest("main-loop-entry-handoff: arriving at home resumes tool choice and completes the original capability", { timeout: 30_000 }, async () => {
  await withLab("main-loop-entry-handoff", async ({ page, plane }) => {
    plane.mainPlan = [
      { choices: [{ message: { tool_calls: [{ id: "entry", type: "function", function: { name: "navigate_scene", arguments: JSON.stringify({ sceneId: "scene-home" }) } }] } }] },
      { choices: [{ message: { tool_calls: [{ id: "execute", type: "function", function: { name: "call_capability", arguments: JSON.stringify({ capabilityId: "capability-search", input: { keyword: "lamp" } }) } }] } }] },
    ];
    await page.goto(`${SITE_ORIGIN}/results/previous`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.open());
    await page.evaluate(() => { void window.SiteWake.run("搜索 lamp 并读取数量"); });
    const run = await waitForTerminal(plane);
    assert.equal(run.status, "completed");
    assert.equal(run.output.count, 7);
    assert.equal(plane.handoffs, 2, "entry navigation and capability navigation both preserve the run");
    assert.equal(plane.claims, 2);
    assert.ok(plane.modelCalls[1].messages.some(message => message.role === "tool" && message.content.includes('"taskComplete":false')));
    assert.equal(run.goal, "搜索 lamp 并读取数量");
    const presentation = await page.evaluate(() => {
      const root = document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot;
      return { text: root?.querySelector(".messages")?.textContent || "", traces: root?.querySelectorAll("details.run-trace").length, logs: root?.querySelectorAll(".tool-log").length, expanded: root?.querySelectorAll("details.run-trace[open]").length };
    });
    assert.match(presentation.text, /搜索 lamp 并读取数量/);
    assert.equal(presentation.traces, 1);
    assert.equal(presentation.logs, 0);
    assert.equal(presentation.expanded, 0);
  });
});

/**
 * One production capability generation received an experience with only the typed
 * keyword: the search button click that led to the results page was lost. The old
 * code recorded the click after it completed, and a native form submit replaces the
 * document before that line ever runs. The capability center generates from this
 * experience; without the submit step it can only guess.
 */
labTest("experience-keeps-navigating-click: the submit click that changes the document is part of the recorded experience", { timeout: 30_000 }, async () => {
  await withLab("experience-keeps-navigating-click", async ({ page, plane }) => {
    plane.mainPlan = [{ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "main_1", type: "function", function: { name: "operate_page", arguments: JSON.stringify({ objective: "搜索 lamp" }) } }] } }] }];
    // Element indices come from the page agent's own observation: find the search box and the "搜索" button in the latest model request.
    const indexOf = (pattern) => {
      const text = JSON.stringify(plane.modelCalls.at(-1)?.messages || []);
      const match = text.match(pattern);
      if (!match) throw new Error(`element not observed: ${pattern}`);
      return Number(match[1]);
    };
    const steps = [
      () => ({ input_text: { index: indexOf(/\[(\d+)\][^\[]{0,80}搜索关键词/u), text: "lamp" } }),
      () => ({ click_element_by_index: { index: indexOf(/\[(\d+)\]<button[^\[]{0,40}搜索/u) } }),
      () => ({ done: { text: "已搜索 lamp。", success: true, outcome: "success", output: { count: 7 }, completionEvidence: [{ criterion: "Complete the user's original objective: 搜索 lamp", evidence: "搜索结果" }] } }),
    ];
    plane.adaptivePlan = { shift: () => steps.shift()?.() };
    await page.goto(`${SITE_ORIGIN}/`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("搜索 lamp")).catch(() => undefined);
    const run = await waitForTerminal(plane, 15_000);
    assert.equal(run.status, "completed");
    assert.equal(plane.episodeBodies.length, 1, "one adaptive episode");
    const actions = plane.episodeBodies[0].episode?.experience?.actions || plane.episodeBodies[0].experience?.actions || [];
    assert.deepEqual(actions.map((action) => [action.action, action.rawAction]), [["fill", "input_text"], ["click", "click_element_by_index"]], JSON.stringify(plane.episodeBodies[0]).slice(0, 600));
    assert.match(actions[1].page.url, /\/$/, "点击记录在起始页上");
  });
});

/**
 * A session that only followed links (region page → country page) arrived at the
 * capability center with no actions at all: the anchor click was recorded after
 * onNavigateAction had already committed the checkpoint the next document resumes
 * from. Record it before the handoff.
 */
labTest("experience-keeps-anchor-click: a link click that hands the run to the next document is part of the recorded experience", { timeout: 30_000 }, async () => {
  await withLab("experience-keeps-anchor-click", async ({ page, plane }) => {
    plane.mainPlan = [{ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "main_1", type: "function", function: { name: "operate_page", arguments: JSON.stringify({ objective: "打开 lamp 搜索结果" }) } }] } }] }];
    const indexOf = (pattern) => {
      const text = JSON.stringify(plane.modelCalls.at(-1)?.messages || []);
      const match = text.match(pattern);
      if (!match) throw new Error(`element not observed: ${pattern}`);
      return Number(match[1]);
    };
    const steps = [
      () => ({ click_element_by_index: { index: indexOf(/\[(\d+)\]<a[^\[]{0,80}打开 lamp 搜索结果/u) } }),
      () => ({ done: { text: "已打开 lamp 搜索结果。", success: true, outcome: "success", output: { count: 7 }, completionEvidence: [{ criterion: "Complete the user's original objective: 打开 lamp 搜索结果", evidence: "搜索结果" }] } }),
    ];
    plane.adaptivePlan = { shift: () => steps.shift()?.() };
    // The simulator cursor visitors watch is driven by these window events; the
    // link handoff path used to leave it parked while the page changed.
    await page.context().addInitScript(() => {
      window.addEventListener("PageAgent::MovePointerTo", (event) => {
        const moves = JSON.parse(localStorage.getItem("__pointerMoves") || "[]");
        moves.push(event.detail);
        localStorage.setItem("__pointerMoves", JSON.stringify(moves));
      });
    });
    await page.goto(`${SITE_ORIGIN}/`);
    await page.waitForFunction(() => Boolean(window.SiteWake));
    await page.evaluate(() => window.SiteWake.run("打开 lamp 搜索结果")).catch(() => undefined);
    const run = await waitForTerminal(plane, 15_000);
    assert.equal(run.status, "completed");
    assert.equal(plane.episodeBodies.length, 1, "one adaptive episode");
    const actions = plane.episodeBodies[0].episode?.experience?.actions || plane.episodeBodies[0].experience?.actions || [];
    assert.deepEqual(actions.map((action) => [action.action, action.rawAction, action.page?.url]), [["click", "click_element_by_index", `${SITE_ORIGIN}/`]], JSON.stringify(plane.episodeBodies[0]).slice(0, 600));
    const pointerMoves = await page.evaluate(() => JSON.parse(localStorage.getItem("__pointerMoves") || "[]"));
    assert.ok(pointerMoves.some((move) => move && move.x > 0 && move.y > 0), `the simulator cursor moved to the link before the handoff: ${JSON.stringify(pointerMoves)}`);
  });
});

/**
 * Stopping is a terminal outcome like a failure: the user gets "try again" and
 * "show me once" instead of a dead end, the turn's disclosure says "stopped"
 * rather than "completed", and the very next request starts cleanly — the port
 * used to keep the stopped task's in-flight flag and aborted controller, so the
 * next request was refused as "running on another page" or aborted at startup.
 */
labTest("stop-then-retry: a stopped turn offers retry/teach and the next request starts cleanly", { timeout: 40_000 }, async () => {
  await withLab("stop-then-retry", async ({ page, plane }) => {
    plane.modelDelayMs = 400;
    await page.goto(`${SITE_ORIGIN}/`); await page.waitForFunction(() => Boolean(window.SiteWake));
    // A conversational turn: long enough (model delay) to be stopped mid-turn, and
    // it stays on this document, so what is measured is the port's own bookkeeping.
    await page.evaluate(() => { void window.SiteWake.run("你好"); });
    await page.waitForFunction(() => document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot?.querySelector(".composer.running"), null, { timeout: 5_000 });
    await page.waitForTimeout(60);
    await page.evaluate(() => { document.querySelector("[data-sitewake-agent='widget']").shadowRoot.querySelector(".stop").click(); });
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => {
      const root = document.querySelector("[data-sitewake-agent='widget']").shadowRoot;
      const rows = [...root.querySelectorAll(".message-row")];
      const last = rows.at(-1);
      return { text: last?.querySelector(".message")?.textContent, buttons: [...(last?.querySelectorAll(".actions button") || [])].map((b) => b.textContent), running: Boolean(root.querySelector(".composer.running")) };
    });
    assert.equal(state.running, false);
    assert.match(state.text || "", /Task stopped|任务已停止/);
    assert.ok(["Try again,Let me show you", "再试一次,我操作一次给你看"].includes(state.buttons.join(",")), JSON.stringify(state));
    const stopped = [...plane.runs.values()][0]?.run;
    assert.equal(stopped?.status, "cancelled");
    // The next request must not be refused or aborted by the stopped task's
    // leftovers — including the stopped task's model reply, which is still on
    // its way (400ms delay) and used to make the stopped task's failure path
    // mark *this* run failed.
    await page.evaluate(() => { void window.SiteWake.run("你好"); });
    await page.waitForTimeout(1500);
    const errorsEarly = await page.evaluate(() => [...document.querySelector("[data-sitewake-agent='widget']").shadowRoot.querySelectorAll(".message-row.error .message")].map((el) => el.textContent));
    assert.equal([...plane.runs.values()].length, 2, `a second run was created; errors=${JSON.stringify(errorsEarly)}`);
    const run = await waitForTerminal(plane, 15_000).catch(async (error) => {
      const second = [...plane.runs.values()][1]?.run;
      const widgetText = await page.evaluate(() => document.querySelector("[data-sitewake-agent='widget']").shadowRoot.querySelector(".messages")?.textContent);
      throw new Error(`${error.message}; second run status=${second?.status} timeline=${JSON.stringify((second?.activityTimeline || []).map((i) => [i.kind, i.label, i.state]))} handoffs=${plane.handoffs} claims=${plane.claims} url=${page.url()} widget=${String(widgetText).slice(0, 300)}`);
    });
    assert.equal(run.status, "completed", JSON.stringify(run.outcome));
    const errors = await page.evaluate(() => [...document.querySelector("[data-sitewake-agent='widget']").shadowRoot.querySelectorAll(".message-row.error .message")].map((el) => el.textContent));
    assert.deepEqual(errors, [], "no startup error after a stop");
  });
});
