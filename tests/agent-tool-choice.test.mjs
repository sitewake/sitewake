import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../client/user-agent-port.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
globalThis.window = {};
const temporary = await mkdtemp(join(tmpdir(), "sitewake-agent-loop-"));
const modulePath = join(temporary, "port.mjs");
await writeFile(modulePath, bundle.outputFiles[0].text);
after(() => rm(temporary, { recursive: true, force: true }));
const { AgentPort } = await import(pathToFileURL(modulePath).href);
const candidate = { capabilityId: "rank-detail", name: "按排名打开详情", description: "打开指定排名的热搜详情", contract: { inputSchema: { type: "object", properties: { rank: { type: "number" } }, required: ["rank"] } } };
const call = (name, args = {}) => ({ choices: [{ message: { tool_calls: [{ id: crypto.randomUUID(), function: { name, arguments: JSON.stringify(args) } }] } }] });
function fixture(goal, search, decide) {
  const port = Object.create(AgentPort.prototype);
  Object.assign(port, {
    release: { capabilities: [], scenes: [], navigationTools: [] }, options: { siteAgentId: "hotsearch", runtimeMode: "full" },
    directNavigationCapability: () => undefined, verifiedSceneForNavigation: () => undefined,
    capabilityAllowed: () => true, capabilityToolbox: () => [], searchCapabilitiesV2: search,
    status: () => {}, completeMainAgentTurn: decide,
    executeCapabilityV2ById: async (_, id, input) => ({ id, input }),
    runAdaptive: async () => ({ page: true }),
  });
  return () => port.runMainAgent({ id: "run", goal, input: {}, conversation: [] });
}

test("navigation can use a typed published capability without exploring", async () => {
  const run = fixture("打开第 3 个热搜", async () => [candidate], async (messages, tools) => {
    assert.ok(tools.some(t => t.function.name === "capability_v2_1"));
    assert.doesNotMatch(messages[0].content, /不得调用 search_capabilities/);
    return call("capability_v2_1", { rank: 3 });
  });
  assert.deepEqual(await run(), { id: "rank-detail", input: { rank: 3 } });
});

test("navigation can discover a capability through search and bind another rank", async () => {
  let queries = 0, turns = 0;
  const run = fixture("打开第 10 个热搜", async () => ++queries === 1 ? [] : [candidate], async (messages) => {
    if (++turns === 1) return call("search_capabilities", { query: "排名详情", queries: ["热搜", "详情"] });
    const result = JSON.parse(messages.at(-1).content).result;
    assert.equal(result[0].id, candidate.capabilityId);
    return call("call_capability", { capabilityId: candidate.capabilityId, input: { rank: 10 } });
  });
  assert.deepEqual(await run(), { id: "rank-detail", input: { rank: 10 } });
});

test("one fuzzy candidate with no required inputs does not force execution", async () => {
  let decided = false;
  const unrelated = { ...candidate, contract: { inputSchema: { type: "object", properties: {} } } };
  const run = fixture("打开演员热搜", async () => [unrelated], async () => { decided = true; return call("operate_page"); });
  assert.deepEqual(await run(), { page: true });
  assert.equal(decided, true);
});

test("catalog outage is visible to the Agent and the same search can be retried", async () => {
  let queries = 0, turns = 0;
  const run = fixture("打开第 3 个热搜", async () => {
    if (++queries <= 2) throw new Error("503");
    return [candidate];
  }, async (messages) => {
    ++turns;
    if (turns === 1) assert.match(messages[0].content, /预取失败/);
    if (turns === 2) {
      const error = JSON.parse(messages.at(-1).content);
      assert.equal(error.error, "capability_catalog_unavailable");
      assert.equal(error.retryable, true);
    }
    if (turns <= 2) return call("search_capabilities", { query: "排名详情", queries: ["热搜", "详情"] });
    return call("call_capability", { capabilityId: candidate.capabilityId, input: { rank: 3 } });
  });
  assert.deepEqual(await run(), { id: "rank-detail", input: { rank: 3 } });
  assert.equal(queries, 3);
});

const home = { id: "home", name: "热搜时光机首页", directEntry: "verified", parameters: [], urlTemplates: [{ id: "home-url", originPattern: "https://www.example.org", pathnamePattern: "/", query: {} }] };
function scenePort(goal, decide, options = {}) {
  const port = Object.create(AgentPort.prototype);
  const session = { id: "run-scene", goal, input: {}, conversation: [], status: "running" };
  Object.assign(port, {
    release: { capabilities: [], scenes: [home], navigationTools: [] }, options: { siteAgentId: "hotsearch", runtimeMode: "full", ...options },
    directNavigationCapability: () => undefined, verifiedSceneForNavigation: () => undefined,
    capabilityAllowed: () => true, capabilityToolbox: () => [], searchCapabilitiesV2: async () => [candidate],
    searchKnowledge: () => [{ id: "home", type: "scene", name: home.name }], searchContentPassages: async () => ({ items: [], totalPagesWithHits: 0 }),
    status: () => {}, completeMainAgentTurn: decide,
    completeConversation: () => { throw new Error("premature_completion"); },
    executeCapabilityV2ById: async (_, id, input) => ({ id, input }),
    runAdaptive: async () => ({ page: true }), activeSession: session, activityTimeline: [],
  });
  return { port, session };
}

test("production regression: entering home does not fulfill 点开第 4 个热搜", async () => {
  globalThis.location = new URL("https://www.example.org/");
  let turn = 0;
  const { port, session } = scenePort("点开第 4 个热搜", async (messages, tools, streamAnswer) => {
    assert.equal(streamAnswer, false, "unverified completion text is not streamed to the visitor");
    switch (++turn) {
      case 1: return call("search_site_knowledge", { keywords: ["热搜"] });
      case 2: return call("navigate_scene", { sceneId: "home" });
      case 3:
        assert.equal(JSON.parse(messages.at(-1).content).taskComplete, false);
        return { choices: [{ message: { content: "已进入首页，任务完成。" } }] };
      default:
        assert.match(messages.at(-1).content, /尚无完成原始目标/);
        return call("capability_v2_1", { rank: 4 });
    }
  });
  assert.deepEqual(await port.runMainAgent(session), { id: candidate.capabilityId, input: { rank: 4 } });
});

test("scene navigation persists the loop; a new document resumes the original goal and tools", async () => {
  globalThis.location = new URL("https://www.example.org/previous");
  let saved;
  const departure = scenePort("点开第 4 个热搜", async () => call("navigate_scene", { sceneId: "home" }));
  departure.port.saveCheckpoint = checkpoint => { saved = checkpoint; };
  departure.port.navigateWithRun = async () => { throw new Error("document_handoff"); };
  departure.port.handoffCommitted = true;
  await assert.rejects(departure.port.runMainAgent(departure.session), /document_handoff/);
  assert.ok(saved?.mainAgent, "checkpoint must contain the main Agent loop, not a canned success answer");
  assert.equal(saved.directAnswer, undefined);
  globalThis.location = new URL("https://www.example.org/");
  const destination = scenePort("点开第 4 个热搜", async messages => {
    assert.ok(messages.some(m => m.role === "tool" && JSON.parse(m.content).taskComplete === false));
    assert.match(messages.at(-1).content, /继续原始任务：点开第 4 个热搜/);
    return call("capability_v2_1", { rank: 4 });
  });
  assert.deepEqual(await destination.port.runMainAgent(destination.session, saved.mainAgent), { id: candidate.capabilityId, input: { rank: 4 } });
});

test("a tool error is feedback; the Agent can correct arguments without restarting", async () => {
  let turn = 0;
  const { port, session } = scenePort("点开第 4 个热搜", async messages => {
    if (++turn === 1) return call("call_capability", { capabilityId: "nonexistent", input: {} });
    assert.match(JSON.parse(messages.at(-1).content).error, /capability_not_available/);
    return call("capability_v2_1", { rank: 4 });
  });
  assert.deepEqual(await port.runMainAgent(session), { id: candidate.capabilityId, input: { rank: 4 } });
});

test("the Agent can ask for a missing rank then call the same capability", async () => {
  let turn = 0;
  const { port, session } = scenePort("打开那个热搜", async messages => {
    if (++turn === 1) return call("ask_user", { question: "你想打开第几个热搜？" });
    assert.equal(JSON.parse(messages.at(-1).content).answer, "第 4 个");
    return call("capability_v2_1", { rank: 4 });
  }, { onAskUser: async () => "第 4 个" });
  assert.deepEqual(await port.runMainAgent(session), { id: candidate.capabilityId, input: { rank: 4 } });
  assert.equal(session.conversation.at(-1).content, "第 4 个");
});

test("missing inputs are returned to the loop before execution authorization is requested", async () => {
  let turns = 0;
  const { port, session } = scenePort("点开第 4 个热搜", async messages => {
    if (++turns === 1) return call("capability_v2_1", {});
    assert.equal(JSON.parse(messages.at(-1).content).success, false);
    return call("capability_v2_1", { rank: 4 });
  });
  assert.deepEqual(await port.runMainAgent(session), { id: candidate.capabilityId, input: { rank: 4 } });
  assert.equal(turns, 2);
});


test("tool contracts do not reserve live page access for exploration", async () => {
  const run = fixture("点开第三个热搜", async () => [candidate], async (messages, tools) => {
    const published = tools.find(t => t.function.name === "capability_v2_1").function;
    const page = tools.find(t => t.function.name === "operate_page").function;
    const knowledge = tools.find(t => t.function.name === "search_site_knowledge").function;
    assert.match(published.description, /executable browser program/);
    assert.match(page.description, /Published capabilities also read and operate the live page/);
    assert.doesNotMatch(page.description, /only tool that reads the live page/);
    assert.doesNotMatch(knowledge.description, /Only use the page tool when you must act/);
    assert.match(messages[0].content, /不是知识条目或缓存结果/);
    return call("capability_v2_1", { rank: 3 });
  });
  assert.deepEqual(await run(), { id: "rank-detail", input: { rank: 3 } });
});
