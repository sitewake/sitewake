import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

process.env.CAPABILITY_V2_AUTO_DISPATCH = "0";
process.env.SITEWAKE_PAGE_AGENT_RUNTIME_V2 = "";
process.env.SITEWAKE_PAGE_AGENT_EVIDENCE_V2 = "";
process.env.SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX = "";
process.env.OPENAI_API_KEY = "intake-test-key";
process.env.OPENAI_BASE_URL = "https://model.intake.test/v1";
process.env.OPENAI_MODEL = "intake-test-model";

async function stores(database) {
  const key = `__INTAKE_TEST_DB_${crypto.randomUUID()}`;
  globalThis[key] = database;
  const result = await build({
    stdin: { contents: `export * as runs from "../db/agent-run-store";
      export * as sites from "../db/site-agent-store";
      export * as outbox from "../db/capability-experience-outbox-store";
      export * as capabilities from "../db/capability-center-v2-store";
      export * as authority from "../lib/capability-center-v2/experience-authority";`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "isolated-db", setup(builder) {
      builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({ loader: "ts", contents:
        `const db=globalThis[${JSON.stringify(key)}];export function getD1Binding(){return db};export function getArtifactBinding(){return null};export class D1UnavailableError extends Error{}` }));
    } }],
  });
  try {
    const loaded = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
    // The plugin above isolates the D1 binding, and each call gets its own
    // module instance — but the in-memory stores live on `globalThis`, so every
    // instance shares them. Without this, the D1 test's leftovers were still in
    // the outbox when the memory test called `processCapabilityExperienceOutbox(1)`:
    // it processed somebody else's item, failed its authority check, and
    // reported `processed: 0` with that item's error. It failed about one run in
    // twenty, which is exactly often enough to be dismissed as noise.
    loaded.outbox.resetMemoryCapabilityExperienceOutbox();
    loaded.sites.resetMemorySiteAgentStore();
    loaded.capabilities.resetCapabilityCenterV2ForTests();
    for (const name of [
      "__SITEWAKE_AGENT_RUN_V3__",
      "__SITEWAKE_AGENT_RUN_EVENTS_V3__",
      "__SITEWAKE_PAGE_OBSERVATIONS_V3__",
      "__SITEWAKE_PAGE_OBSERVATION_TOMBSTONES_V3__",
    ]) globalThis[name]?.clear();
    return loaded;
  }
  finally { delete globalThis[key]; }
}

// Public page facts from the production incident; no user/session credentials.
async function thirdHotsearch(store, mode = "adaptive", experienceOverride) {
  const siteAgentId = `hotsearch-${crypto.randomUUID()}`;
  const url = "https://www.example.org/";
  await store.sites.createSiteAgent({ id: siteAgentId, name: "热搜接入回归", url });
  const browserSessionId = crypto.randomUUID(), documentId = crypto.randomUUID();
  const created = await store.runs.createAgentRun({ siteAgentId, origin: new URL(url).origin, url,
    goal: "点开第三个热搜", taskInput: {}, browserSessionId, documentId, controller: "page-agent", requestOrigin: new URL(url).origin });
  const now = new Date().toISOString();
  const snapshot = { schemaVersion: "site-agent.v2", url, title: "微博热搜历史查询", headings: [], elements: [], visibleText: "3 青春华章因创新更燃", links: [], capturedAt: now };
  const endSnapshot = { ...snapshot, url: `${url}?topic=WnffTw` };
  await store.sites.recordSiteAgentConnection(siteAgentId, { origin: new URL(url).origin, url, title: snapshot.title, heading: snapshot.title, snapshot });
  const episode = { schemaVersion: "site-agent.v2", id: `episode_${crypto.randomUUID()}`, siteAgentId, taskSessionId: created.run.id,
    browserSessionId, documentId, mode, goal: created.run.goal, normalizedGoal: created.run.goal,
    input: {}, startedAt: now, endedAt: now, startSnapshot: snapshot, endSnapshot, transitions: [],
    outcome: { status: "success", code: "agent_completed", summary: "已成功打开第三个热搜「青春华章因创新更燃」的详情页面。", evaluatedAt: now, evidence: {} },
    experience: experienceOverride
      ? experienceOverride(now, endSnapshot)
      : { version: 1, actorSummary: "打开了第 3 个热搜", judgeEvidence: [], actions: [{ action: "click", rawAction: "click_element_by_index", input: { index: 34 }, element: { tag: "div", accessibleName: "3青春华章因创新更燃🎉70.8万微博5小时", landmark: "main" }, page: endSnapshot, observedAt: now }] } };
  const authorized = await store.runs.authorizeAgentRunEpisode(created.run.id, created.resumeToken, episode);
  assert.equal(authorized.experienceAuthority?.kind, "legacy-create");
  return { ...created, episode, authorized, siteAgentId };
}

function modelFixture() {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
    name: "按排名打开热搜详情", description: "按用户提供的排名打开热搜详情", aliases: [], intent: "打开指定排名的热搜详情",
    parameters: [{ name: "rank", type: "number", description: "热搜排名", required: true, exampleValue: 3 }],
  }) } }] }), { headers: { "content-type": "application/json" } });
}

for (const persistence of ["memory", "d1"]) test(`third hotsearch: durable intake, failure, retry and single task (${persistence})`, async t => {
  const mf = persistence === "d1" ? new Miniflare({ script: "export default { fetch(){return new Response('ok')} }", modules: true, d1Databases: ["DB"] }) : undefined;
  const database = mf ? await mf.getD1Database("DB") : null;
  const store = await stores(database);
  const originalFetch = globalThis.fetch;
  try {
    const c = await thirdHotsearch(store);
    const append = () => store.sites.appendTaskEpisode(c.siteAgentId, c.episode, c.authorized);
    await append();
    let items = await store.outbox.listCapabilityExperienceIntakes(c.siteAgentId);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "pending");
    assert.equal(items[0].goal, "点开第三个热搜");
    assert.equal((await store.capabilities.listTasks(c.siteAgentId)).tasks.length, 0, "receipt visible before any model or task exists");
    assert.equal((await store.outbox.listCapabilityExperienceIntakes("another-site")).length, 0);
    assert.equal((await store.outbox.listCapabilityExperienceIntakes(c.siteAgentId, "another-run")).length, 0);
    assert.equal(await store.outbox.retryCapabilityExperienceIntake("another-site", items[0].id), false);
    assert.equal(store.authority.legacyCapabilityExperienceAuthority({ ...c.authorized.run, agentState: {} }, c.episode), undefined);
    assert.equal(store.authority.legacyCapabilityExperienceAuthority(c.authorized.run, { ...c.episode, experience: { ...c.episode.experience, observationRefs: [{ id: "v2-proof" }] } }), undefined, "never downgrade V2 evidence");
    if (database) {
      const signals = await database.prepare("SELECT COUNT(*) AS n FROM site_agent_v2_capability_signals WHERE site_agent_id=?").bind(c.siteAgentId).all();
      assert.equal(signals.results[0].n, 0, "new Episodes no longer feed the legacy factory");
      await database.prepare("DELETE FROM site_agent_v3_capability_experience_outbox WHERE id=?").bind(items[0].id).run();
      assert.equal((await store.outbox.reconcileCapabilityExperienceOutbox()).enqueued, 1, "pre-release persisted Episode recovers without browser repost");
    }
    // Model is unavailable before a formal task can be created.
    globalThis.fetch = async () => { throw new Error("model_temporarily_unavailable"); };
    assert.equal((await store.outbox.processCapabilityExperienceOutbox(1)).failed, 1);
    items = await store.outbox.listCapabilityExperienceIntakes(c.siteAgentId);
    assert.equal(items[0].status, "pending");
    assert.match(items[0].lastError, /unavailable/);
    assert.ok(items[0].nextAttemptAt);
    assert.equal((await store.capabilities.listTasks(c.siteAgentId)).tasks.length, 0);
    await append();
    assert.equal((await store.outbox.listCapabilityExperienceIntakes(c.siteAgentId)).length, 1);
    globalThis.fetch = async () => modelFixture();
    await store.outbox.retryCapabilityExperienceIntake(c.siteAgentId, items[0].id);
    const processed = await store.outbox.processCapabilityExperienceOutbox(1);
    items = await store.outbox.listCapabilityExperienceIntakes(c.siteAgentId);
    assert.equal(processed.processed, 1, items[0].lastError);
    assert.equal(items[0].status, "completed");
    assert.equal(items[0].disposition, "Created");
    const tasks = (await store.capabilities.listTasks(c.siteAgentId)).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].sourceAgentRunId, c.run.id);
    assert.equal(tasks[0].input.experience.episodeId, c.episode.id);
    assert.equal(items[0].taskId, tasks[0].id);
    await append();
    await store.outbox.processCapabilityExperienceOutbox(1);
    assert.equal((await store.capabilities.listTasks(c.siteAgentId)).tasks.length, 1);
    assert.equal(await store.outbox.retryCapabilityExperienceIntake(c.siteAgentId, items[0].id), false);
  } finally { globalThis.fetch = originalFetch; await mf?.dispose(); }
});

test("D1 receipt is atomic, retries stop, and a restarted worker keeps one identity", async () => {
  const mf = new Miniflare({ script: "export default {fetch(){return new Response('ok')}}", modules: true, d1Databases: ["DB"] });
  const database = await mf.getD1Database("DB");
  const store = await stores(database);
  const originalFetch = globalThis.fetch;
  try {
    const c = await thirdHotsearch(store);
    // Fail the receipt INSERT inside the same transaction as the Episode.
    await database.prepare("CREATE TRIGGER reject_intake BEFORE INSERT ON site_agent_v3_capability_experience_outbox BEGIN SELECT RAISE(ABORT, 'intake_write_failed'); END").run();
    await assert.rejects(store.sites.appendTaskEpisode(c.siteAgentId, c.episode, c.authorized), /intake_write_failed/);
    const episodes = await database.prepare("SELECT COUNT(*) AS n FROM site_agent_v2_episodes WHERE id=?").bind(c.episode.id).all();
    assert.equal(episodes.results[0].n, 0, "do not acknowledge evidence without its durable intake");
    await database.prepare("DROP TRIGGER reject_intake").run();
    await store.sites.appendTaskEpisode(c.siteAgentId, c.episode, c.authorized);
    const [initial] = await store.outbox.listCapabilityExperienceIntakes(c.siteAgentId);
    globalThis.fetch = async () => { throw new Error("model_temporarily_unavailable"); };
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt) await store.outbox.retryCapabilityExperienceIntake(c.siteAgentId, initial.id);
      await store.outbox.processCapabilityExperienceOutbox(1);
    }
    const [failed] = await store.outbox.listCapabilityExperienceIntakes(c.siteAgentId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 8);
    assert.equal(failed.nextAttemptAt, undefined);
    assert.equal((await store.outbox.processCapabilityExperienceOutbox(1)).processed, 0);
    await store.outbox.retryCapabilityExperienceIntake(c.siteAgentId, initial.id);
    await database.prepare("UPDATE site_agent_v3_capability_experience_outbox SET status='processing',updated_at=? WHERE id=?").bind(new Date(Date.now() - 11 * 60_000).toISOString(), initial.id).run();
    const restarted = await stores(database);
    globalThis.fetch = async () => modelFixture();
    await Promise.all([restarted.outbox.processCapabilityExperienceOutbox(1), restarted.outbox.processCapabilityExperienceOutbox(1)]);
    const [completed] = await restarted.outbox.listCapabilityExperienceIntakes(c.siteAgentId);
    assert.equal(completed.status, "completed", completed.lastError);
    assert.equal((await restarted.capabilities.listTasks(c.siteAgentId)).tasks.length, 1);
  } finally { globalThis.fetch = originalFetch; await mf.dispose(); }
});

test("a hand-made demonstration is taken in like an adaptive run (memory)", async () => {
  // Production: the visitor demonstrated "看看昨天有什么热搜" by hand after stopping the
  // agent; the demonstration episode was stored but never entered the intake queue
  // because every gate on the path admitted only mode === "adaptive".
  const store = await stores(null);
  const originalFetch = globalThis.fetch;
  try {
    const c = await thirdHotsearch(store, "demonstration");
    const demonstration = c.episode;
    assert.equal(c.authorized.experienceAuthority?.kind, "legacy-create", "a demonstration reaches capability intake");
    await store.sites.appendTaskEpisode(c.siteAgentId, demonstration, c.authorized);
    const items = await store.outbox.listCapabilityExperienceIntakes(c.siteAgentId);
    assert.equal(items.length, 1);
    globalThis.fetch = async () => modelFixture();
    const processed = await store.outbox.processCapabilityExperienceOutbox(1);
    assert.equal(processed.processed, 1, (await store.outbox.listCapabilityExperienceIntakes(c.siteAgentId))[0]?.lastError);
    const tasks = (await store.capabilities.listTasks(c.siteAgentId)).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].input.experience.episodeId, demonstration.id);
  } finally { globalThis.fetch = originalFetch; }
});

test("a run that only went to an address still reaches the capability centre", async () => {
  // Production: 「打开2026-09-15的热搜榜」 succeeded by entering one verified
  // Scene and reading it. It operated nothing, so every gate on the path read
  // it as a run that had never touched the site, and the site's most reusable
  // capability — an answer that lives at a parameterized route — was the one
  // kind that could never be learned.
  const store = await stores(null);
  const originalFetch = globalThis.fetch;
  try {
    const c = await thirdHotsearch(store, "adaptive", (now, endSnapshot) => ({
      version: 1,
      actorSummary: "\u5df2\u6253\u5f00\u5f53\u65e5\u70ed\u641c\u699c",
      judgeEvidence: [],
      actions: [],
      routes: [{ url: endSnapshot.url, sceneId: "scene-daily", bindings: { date: "2026-09-15" }, observedAt: now }],
    }));
    assert.equal(c.authorized.experienceAuthority?.kind, "legacy-create", "an entered address is page evidence");
    await store.sites.appendTaskEpisode(c.siteAgentId, c.episode, c.authorized);
    assert.equal((await store.outbox.listCapabilityExperienceIntakes(c.siteAgentId)).length, 1);
    // The value bound into the address is as much a demonstrated input as one
    // typed into a field, so it is a legal exampleValue.
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      name: "\u6253\u5f00\u6307\u5b9a\u65e5\u671f\u7684\u70ed\u641c\u699c", description: "\u6309\u65e5\u671f\u6253\u5f00\u5f53\u65e5\u70ed\u641c\u699c", aliases: [], intent: "\u6253\u5f00\u6307\u5b9a\u65e5\u671f\u7684\u70ed\u641c\u699c",
      parameters: [{ name: "date", type: "string", description: "\u65e5\u671f", required: true, exampleValue: "2026-09-15" }],
    }) } }] }), { headers: { "content-type": "application/json" } });
    const processed = await store.outbox.processCapabilityExperienceOutbox(1);
    assert.equal(processed.processed, 1, (await store.outbox.listCapabilityExperienceIntakes(c.siteAgentId))[0]?.lastError);
    const tasks = (await store.capabilities.listTasks(c.siteAgentId)).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].input.experience.routes?.length, 1, "the address survives intake");
    assert.equal(tasks[0].input.parameters.date, "2026-09-15", "the value bound into the address is a parameter");
    // The Runner begins where the run stood, not where the visitor happened to be.
    assert.equal(tasks[0].input.context.startUrl, c.episode.endSnapshot.url);
  } finally { globalThis.fetch = originalFetch; }
});
