import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

let databaseSequence = 0;

async function isolatedStore(t) {
  const sequence = databaseSequence += 1;
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `page-observation-store-${sequence}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const databaseKey = `__PAGE_OBSERVATION_D1_${sequence}`;
  globalThis[databaseKey] = database;
  try {
    const result = await build({
      stdin: {
        contents: `
          export * as observations from "../db/page-observation-store";
          export { pageObservationSha256 } from "../lib/capability-center-v2/page-observation";
        `,
        resolveDir: fileURLToPath(new URL(".", import.meta.url)),
        sourcefile: `page-observation-store-d1-${sequence}.ts`,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: [{
        name: "isolated-page-observation-d1",
        setup(builder) {
          builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
            contents: `
              const database = globalThis[${JSON.stringify(databaseKey)}] || null;
              export function getD1Binding() { return database; }
              export function getArtifactBinding() { return null; }
              export class D1UnavailableError extends Error {}
            `,
            loader: "ts",
          }));
        },
      }],
    });
    const storeModule = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
    return { database, ...storeModule };
  } finally {
    delete globalThis[databaseKey];
  }
}

function runFixture(runId, episodeId) {
  const now = new Date().toISOString();
  return {
    id: runId,
    controller: "page-agent",
    scope: { kind: "site", siteAgentId: "site-d1", allowedOrigins: ["https://shop.test"], knowledgeNamespaceIds: [] },
    status: "running",
    goal: "search for cushion",
    input: { query: "cushion" },
    conversation: [],
    agentState: {},
    activityTimeline: [],
    bindings: {},
    activePort: {
      id: `port-${runId}`,
      documentId: `document-${runId}`,
      browserSessionId: `browser-${runId}`,
      origin: "https://shop.test",
      url: "https://shop.test/catalog",
      pageEpoch: 1,
      claimedAt: now,
      lastSeenAt: now,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: "active",
    },
    pageEpoch: 1,
    eventSequence: 1,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    episodeId,
  };
}

async function observation(store, run, episodeId, turnIndex, id = `${run.id}-observation-${turnIndex}`) {
  const capturedAt = new Date().toISOString();
  const value = {
    schemaVersion: "page-agent-observation.v1",
    id,
    siteAgentId: "site-d1",
    runId: run.id,
    episodeId,
    browserSessionId: run.activePort.browserSessionId,
    documentId: run.activePort.documentId,
    pageEpoch: 1,
    turnIndex,
    kind: turnIndex === 0 ? "full" : "delta",
    ...(turnIndex > 0 ? { baseObservationId: `${run.id}-observation-${turnIndex - 1}` } : {}),
    state: {
      url: "https://shop.test/catalog",
      title: "Catalog",
      header: "Products",
      content: `Cushion results turn ${turnIndex}`,
      footer: "",
    },
    targets: [],
    sha256: "0".repeat(64),
    producer: {
      controller: "@page-agent/page-controller",
      controllerVersion: "1.12.1",
      projection: "user-agent-adaptive",
      projectionVersion: 1,
    },
    capturedAt,
    expiresAt: new Date(Date.parse(capturedAt) + 14 * 86_400_000).toISOString(),
  };
  value.sha256 = await store.pageObservationSha256(value);
  return value;
}

async function appendInChunks(observations, run, items) {
  for (let index = 0; index < items.length; index += 4) {
    await observations.appendPageAgentObservations(run, items.slice(index, index + 4));
  }
}

async function storedCount(database, runId) {
  const result = await database.prepare(`SELECT COUNT(*) AS count FROM site_agent_v3_page_observations WHERE run_id=?`)
    .bind(runId).all();
  assert.equal(result.success, true);
  return Number(result.results[0].count);
}

async function insertOutbox(database, run, episodeId, ref, status) {
  const now = new Date().toISOString();
  const result = await database.prepare(`INSERT INTO site_agent_v3_capability_experience_outbox
    (id,site_agent_id,run_id,episode_id,authority_kind,authority,source_capability_id,source_version_id,
      observation_refs_json,status,attempts,next_attempt_at,result_json,last_error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    `outbox-${episodeId}`,
    "site-d1",
    run.id,
    episodeId,
    "create",
    "create",
    null,
    null,
    JSON.stringify([ref]),
    status,
    0,
    null,
    null,
    null,
    now,
    now,
  ).run();
  assert.equal(result.success, true);
}

test("D1 observation append atomically enforces conflicts and the eleven-record run limit", async (t) => {
  const store = await isolatedStore(t);
  const episodeId = "episode-concurrent-limit";
  const run = runFixture("run-concurrent-limit", episodeId);
  const firstTen = await Promise.all(Array.from({ length: 10 }, (_, turn) => observation(store, run, episodeId, turn)));
  await appendInChunks(store.observations, run, firstTen);

  const candidates = await Promise.all([
    observation(store, run, episodeId, 10),
    observation(store, run, episodeId, 11),
  ]);
  await assert.rejects(
    store.observations.appendPageAgentObservations(run, candidates),
    /page_observation_run_limit/,
    "a batch that would cross the limit rolls back its earlier insert",
  );
  assert.equal(await storedCount(store.database, run.id), 10);
  const raced = await Promise.allSettled(candidates.map((item) => store.observations.appendPageAgentObservations(run, [item])));
  assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(raced.filter((result) => result.status === "rejected" && /page_observation_run_limit/.test(String(result.reason))).length, 1);
  assert.equal(await storedCount(store.database, run.id), 11);

  const winnerIndex = raced.findIndex((result) => result.status === "fulfilled");
  const duplicate = await store.observations.appendPageAgentObservations(run, [candidates[winnerIndex]]);
  assert.deepEqual({ accepted: duplicate.accepted, duplicates: duplicate.duplicates }, { accepted: 0, duplicates: 1 });

  const conflictEpisode = "episode-concurrent-conflict";
  const conflictRun = runFixture("run-concurrent-conflict", conflictEpisode);
  const conflicting = await Promise.all([
    observation(store, conflictRun, conflictEpisode, 0, "conflict-a"),
    observation(store, conflictRun, conflictEpisode, 0, "conflict-b"),
  ]);
  const conflictRace = await Promise.allSettled(conflicting.map((item) => store.observations.appendPageAgentObservations(conflictRun, [item])));
  assert.equal(conflictRace.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(conflictRace.filter((result) => result.status === "rejected" && /page_observation_conflict/.test(String(result.reason))).length, 1);
  assert.equal(await storedCount(store.database, conflictRun.id), 1);
});

test("active outbox states pin evidence while failed uses 14d and Created uses 90d retention", async (t) => {
  const store = await isolatedStore(t);
  const active = [];
  for (const status of ["pending", "evidence-pending", "processing", "failed"]) {
    const episodeId = `episode-retention-${status}`;
    const run = runFixture(`run-retention-${status}`, episodeId);
    const item = await observation(store, run, episodeId, 0);
    await store.observations.appendPageAgentObservations(run, [item]);
    await insertOutbox(store.database, run, episodeId, { id: item.id, sha256: item.sha256 }, status);
    active.push({ status, run, episodeId, item });
  }

  const afterInitialRetention = new Date(Date.now() + 15 * 86_400_000).toISOString();
  const firstPurge = await store.observations.purgeExpiredPageAgentObservations(afterInitialRetention);
  assert.equal(firstPurge.purged, 1, "only terminal failed evidence expires at the initial 14-day boundary");
  for (const entry of active) {
    const stored = await store.observations.getPageAgentObservations(entry.run.id, { includeExpired: true });
    assert.equal(stored.length, entry.status === "failed" ? 0 : 1, entry.status);
  }

  const createdEpisode = "episode-retention-created";
  const createdRun = runFixture("run-retention-created", createdEpisode);
  const createdObservation = await observation(store, createdRun, createdEpisode, 0);
  await store.observations.appendPageAgentObservations(createdRun, [createdObservation]);
  await insertOutbox(store.database, createdRun, createdEpisode, { id: createdObservation.id, sha256: createdObservation.sha256 }, "processing");
  const extension = await store.observations.extendPageAgentObservationRetention(
    createdRun.id,
    createdEpisode,
    new Date(Date.now() + 90 * 86_400_000).toISOString(),
  );
  assert.equal(extension.extended, 1);
  const completed = await store.database.prepare(`UPDATE site_agent_v3_capability_experience_outbox
    SET status='completed',result_json=?,updated_at=? WHERE id=?`).bind(
    JSON.stringify({ disposition: "Created" }),
    new Date().toISOString(),
    `outbox-${createdEpisode}`,
  ).run();
  assert.equal(completed.success, true);

  const afterCompletionPurge = await store.observations.purgeExpiredPageAgentObservations(afterInitialRetention);
  assert.equal(afterCompletionPurge.purged, 0);
  assert.equal((await store.observations.getPageAgentObservations(createdRun.id, { includeExpired: true })).length, 1);
  const afterMaximumRetention = await store.observations.purgeExpiredPageAgentObservations(
    new Date(Date.now() + 91 * 86_400_000).toISOString(),
  );
  assert.equal(afterMaximumRetention.purged, 1);
  assert.deepEqual(await store.observations.getPageAgentObservations(createdRun.id, { includeExpired: true }), []);
});
