import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

let storePromise;
let schemaSequence = 0;
/** A site is born only in `createSiteAgent`; the memory store hangs on globalThis and is shared across bundles. */
let siteStorePromise;
async function ensureSite(id) {
  siteStorePromise ||= build({
    entryPoints: [fileURLToPath(new URL("db/site-agent-store.ts", ROOT))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  }).then((result) => import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`));
  await (await siteStorePromise).createSiteAgent({ id });
}
function capabilityStore() {
  storePromise ||= build({
    entryPoints: [fileURLToPath(new URL("db/capability-center-store.ts", ROOT))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  }).then((result) => import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  ));
  return storePromise;
}

async function d1CapabilityStore(database) {
  const databaseKey = `__SITEWAKE_CAPABILITY_D1_${schemaSequence += 1}`;
  globalThis[databaseKey] = database;
  try {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("db/capability-center-store.ts", ROOT))],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: [{
        name: "capability-d1-binding",
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
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#d1-store-${schemaSequence}`);
  } finally {
    delete globalThis[databaseKey];
  }
}

async function freshSchemaModule() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("db/site-agent-schema.ts", ROOT))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const encoded = Buffer.from(result.outputFiles[0].text).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#schema-${schemaSequence += 1}`);
}

function draftContract(name) {
  return {
    name,
    description: `${name} description`,
    goalTemplate: name,
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
  };
}

function tableBody(schema, table) {
  const match = schema.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS site_agent_v2_${table} \\(([\\s\\S]*?)\\n  \\)`,
  ));
  assert.ok(match, `missing site_agent_v2_${table} DDL`);
  return match[1];
}

test("capability center persists its new write model in exactly four core tables", async () => {
  const schema = await source("db/site-agent-schema.ts");
  const coreTables = [
    "capabilities",
    "capability_versions",
    "capability_proposals",
    "capability_tasks",
  ];

  for (const table of coreTables) tableBody(schema, table);

  const declaredCoreTables = [...schema.matchAll(
    /CREATE TABLE IF NOT EXISTS site_agent_v2_(capabilities|capability_versions|capability_proposals|capability_tasks)\s*\(/g,
  )].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(declaredCoreTables)].sort(),
    [...coreTables].sort(),
    "the migration may retain legacy evidence tables, but the new capability-center model has only four roots",
  );
});

test("an existing CapabilityRun table adds idempotency columns before its unique index", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-run-idempotency-upgrade-${schemaSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  await database.prepare(`CREATE TABLE site_agent_v2_capability_runs (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    project_id text,
    capability_id text NOT NULL,
    status text NOT NULL,
    environment_kind text NOT NULL,
    lease_expires_at text,
    run_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`).run();

  const schema = await freshSchemaModule();
  await schema.ensureSiteAgentV2Schema(database);
  const columns = await database.prepare(`PRAGMA table_info(site_agent_v2_capability_runs)`).all();
  const names = new Set(columns.results.map((row) => row.name));
  for (const column of ["idempotency_key_hash", "request_hash", "response_json"]) {
    assert.ok(names.has(column), column);
  }
  const index = await database.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND name='site_agent_v2_capability_runs_idempotency_idx'`).first();
  assert.equal(index.name, "site_agent_v2_capability_runs_idempotency_idx");
});

test("the explicit four-table backfill is idempotent, verifiable, and preserves legacy rows", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-four-table-backfill-${schemaSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const schema = await freshSchemaModule();
  await schema.ensureSiteAgentV2Schema(database);
  const now = "2026-08-02T00:00:00.000Z";
  await database.prepare(`INSERT INTO site_agent_v2_capability_projects
    (id,site_agent_id,intent_key,stable_key,contract_fingerprint,active_revision_id,latest_revision_id,status,project_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
    "legacy-project", "migration-site", "open-orders", "open-orders", "fingerprint", "legacy-revision", "legacy-revision", "published",
    JSON.stringify({ canonicalCapabilityId: "legacy-capability", stableKey: "open-orders", intentKey: "open-orders", name: "Open orders", goalTemplate: "Open orders", activeRevisionId: "legacy-revision", latestRevisionId: "legacy-revision", operation: "read", resultKind: "page" }),
    now, now,
  ).run();
  await database.prepare(`INSERT INTO site_agent_v2_capability_revisions
    (id,project_id,site_agent_id,revision_number,status,revision_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind(
    "legacy-revision", "legacy-project", "migration-site", 1, "published",
    JSON.stringify({ implementation: {}, validation: { status: "passed" } }), now, now,
  ).run();

  const store = await d1CapabilityStore(database);
  const first = await store.backfillLegacyCapabilityCenter(database);
  const verification = await store.verifyCapabilityCenterMigration(database);
  const second = await store.backfillLegacyCapabilityCenter(database);
  const [legacyProjects, legacyRevisions] = await Promise.all([
    database.prepare(`SELECT COUNT(*) AS count FROM site_agent_v2_capability_projects`).first(),
    database.prepare(`SELECT COUNT(*) AS count FROM site_agent_v2_capability_revisions`).first(),
  ]);

  assert.deepEqual(first, { alreadyApplied: false, capabilities: 1, versions: 1, proposals: 0, tasks: 0 });
  assert.equal(verification.passed, true);
  assert.deepEqual(verification.marker, { expected: "2", actual: "2" });
  assert.deepEqual(verification.counts, { capabilities: 1, versions: 1, proposals: 0, tasks: 0 });
  assert.deepEqual(verification.legacySources, { projects: 1, revisions: 1, signals: 0, learningJobs: 0 });
  assert.equal(verification.catastrophicEmptyBackfill, false);
  assert.equal(second.alreadyApplied, true);
  assert.equal(legacyProjects.count, 1);
  assert.equal(legacyRevisions.count, 1);
});

test("the backfill withholds its marker until every revision-referenced learning job has a Task", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-four-table-coverage-retry-${schemaSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const schema = await freshSchemaModule();
  await schema.ensureSiteAgentV2Schema(database);
  const now = "2026-08-02T00:00:00.000Z";
  await database.prepare(`INSERT INTO site_agent_v2_capability_projects
    (id,site_agent_id,intent_key,stable_key,contract_fingerprint,active_revision_id,latest_revision_id,status,project_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
    "coverage-project", "coverage-site", "coverage", "coverage", "fingerprint", "coverage-revision", "coverage-revision", "published",
    JSON.stringify({ canonicalCapabilityId: "coverage-capability", stableKey: "coverage", name: "Coverage", goalTemplate: "Coverage", activeRevisionId: "coverage-revision", latestRevisionId: "coverage-revision" }),
    now, now,
  ).run();
  await database.prepare(`INSERT INTO site_agent_v2_capability_revisions
    (id,project_id,site_agent_id,revision_number,status,revision_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind(
    "coverage-revision", "coverage-project", "coverage-site", 1, "published",
    JSON.stringify({ learningJobId: "coverage-job", implementation: {}, validation: { status: "passed" } }), now, now,
  ).run();
  const store = await d1CapabilityStore(database);

  await assert.rejects(
    store.backfillLegacyCapabilityCenter(database),
    /capability_center_backfill_coverage_failed:c0:d0:v0:j1:t0:s0/,
  );
  assert.equal(await database.prepare(`SELECT value FROM site_agent_v2_meta WHERE key='capability_center_four_table_backfill'`).first(), null);
  const partial = await database.prepare(`SELECT
    (SELECT COUNT(*) FROM site_agent_v2_capabilities) AS capabilities,
    (SELECT COUNT(*) FROM site_agent_v2_capability_versions) AS versions,
    (SELECT COUNT(*) FROM site_agent_v2_capability_tasks) AS tasks`).first();
  assert.deepEqual(partial, { capabilities: 1, versions: 1, tasks: 0 });

  await database.prepare(`INSERT INTO site_agent_v2_learning_jobs
    (id,site_agent_id,task_session_id,status,result_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).bind("coverage-job", "coverage-site", "coverage-session", "completed", "{}", now, now).run();
  await database.prepare(`INSERT INTO site_agent_v2_capability_tasks
    (id,site_agent_id,proposal_id,capability_id,capability_version_id,type,status,stage,task_json,result_json,evidence_json,error_json,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind("coverage-job", "other-site", null, "other-capability", "other-version", "generate", "queued", "queued", "{}", "{}", "{}", null, null, now, now).run();
  await assert.rejects(
    store.backfillLegacyCapabilityCenter(database),
    /capability_center_backfill_coverage_failed:c0:d0:v0:j0:t1:s0/,
  );
  assert.equal(await database.prepare(`SELECT value FROM site_agent_v2_meta WHERE key='capability_center_four_table_backfill'`).first(), null);
  await database.prepare(`DELETE FROM site_agent_v2_capability_tasks WHERE id='coverage-job'`).run();
  const retried = await store.backfillLegacyCapabilityCenter(database);
  assert.equal(retried.tasks, 1);
  assert.equal((await database.prepare(`SELECT value FROM site_agent_v2_meta WHERE key='capability_center_four_table_backfill'`).first()).value, "2");
  assert.deepEqual(
    await database.prepare(`SELECT id,site_agent_id,capability_id,capability_version_id FROM site_agent_v2_capability_tasks WHERE id='coverage-job'`).first(),
    { id: "coverage-job", site_agent_id: "coverage-site", capability_id: "coverage-capability", capability_version_id: "coverage-revision" },
  );
});

test("the backfill counts target-key collisions across Projects, duplicates, and Signals without writing its marker", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-four-table-coverage-collisions-${schemaSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const schema = await freshSchemaModule();
  await schema.ensureSiteAgentV2Schema(database);
  const now = "2026-08-02T00:00:00.000Z";
  await database.prepare(`INSERT INTO site_agent_v2_capabilities
    (id,site_agent_id,stable_key,intent_key,name,description,goal_template,status,current_version_id,latest_version_id,contract_json,capability_json,unpublished_at,deleted_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind("colliding-capability", "other-site", "other-key", "other", "Other", "", "Other", "draft", null, null, "{}", "{}", null, null, now, now).run();
  const insertProposal = `INSERT INTO site_agent_v2_capability_proposals
    (id,site_agent_id,capability_id,duplicate_capability_id,kind,status,proposal_json,analysis_json,archived_at,deleted_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;
  await database.prepare(insertProposal).bind("migration:duplicate:collision-duplicate", "other-site", null, null, "new", "duplicate", "{}", "{}", null, null, now, now).run();
  await database.prepare(insertProposal).bind("collision-signal", "other-site", null, null, "new", "pending", "{}", "{}", null, null, now, now).run();
  const insertProject = `INSERT INTO site_agent_v2_capability_projects
    (id,site_agent_id,intent_key,stable_key,contract_fingerprint,active_revision_id,latest_revision_id,status,project_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
  await database.prepare(insertProject).bind("collision-project", "coverage-site", "collision", "collision", "fingerprint", null, null, "draft", JSON.stringify({ canonicalCapabilityId: "colliding-capability", stableKey: "collision", name: "Collision", goalTemplate: "Collision" }), now, now).run();
  await database.prepare(insertProject).bind("collision-duplicate", "coverage-site", "duplicate", "duplicate", "fingerprint", null, null, "duplicate", JSON.stringify({ name: "Duplicate", duplicateOf: { capabilityId: "colliding-capability" } }), now, now).run();
  await database.prepare(`INSERT INTO site_agent_v2_capability_signals
    (id,site_agent_id,intent_bucket,status,signal_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).bind("collision-signal", "coverage-site", "collision", "pending", "{}", now, now).run();
  const store = await d1CapabilityStore(database);

  await assert.rejects(
    store.backfillLegacyCapabilityCenter(database),
    /capability_center_backfill_coverage_failed:c1:d1:v0:j0:t0:s1/,
  );
  assert.equal(await database.prepare(`SELECT value FROM site_agent_v2_meta WHERE key='capability_center_four_table_backfill'`).first(), null);
});

test("the backfill rejects an ignored Revision insert that does not cover the mapped Capability", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-four-table-version-collision-${schemaSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const schema = await freshSchemaModule();
  await schema.ensureSiteAgentV2Schema(database);
  const now = "2026-08-02T00:00:00.000Z";
  await database.prepare(`INSERT INTO site_agent_v2_capability_projects
    (id,site_agent_id,intent_key,stable_key,contract_fingerprint,active_revision_id,latest_revision_id,status,project_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind("version-project", "version-site", "version", "version", "fingerprint", "version-collision", "version-collision", "draft", JSON.stringify({ canonicalCapabilityId: "version-capability", stableKey: "version", name: "Version", goalTemplate: "Version", activeRevisionId: "version-collision", latestRevisionId: "version-collision" }), now, now).run();
  await database.prepare(`INSERT INTO site_agent_v2_capability_revisions
    (id,project_id,site_agent_id,revision_number,status,revision_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind("version-collision", "version-project", "version-site", 1, "draft", "{}", now, now).run();
  await database.prepare(`INSERT INTO site_agent_v2_capability_versions
    (id,site_agent_id,capability_id,version,status,implementation_json,validation_json,version_json,published_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind("version-collision", "other-site", "other-capability", 1, "draft", "{}", "{}", "{}", null, now, now).run();
  const store = await d1CapabilityStore(database);
  await assert.rejects(
    store.backfillLegacyCapabilityCenter(database),
    /capability_center_backfill_coverage_failed:c0:d0:v1:j0:t0:s0/,
  );
  assert.equal(await database.prepare(`SELECT value FROM site_agent_v2_meta WHERE key='capability_center_four_table_backfill'`).first(), null);
});

test("an explicit canonical Capability absorbs legacy stable-key drift and preserves colliding revision numbers", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-four-table-canonical-version-rebase-${schemaSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const schema = await freshSchemaModule();
  await schema.ensureSiteAgentV2Schema(database);
  const now = "2026-08-02T00:00:00.000Z";
  await database.prepare(`INSERT INTO site_agent_v2_capabilities
    (id,site_agent_id,stable_key,intent_key,name,description,goal_template,status,current_version_id,latest_version_id,contract_json,capability_json,unpublished_at,deleted_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind("canonical-capability", "canonical-site", "canonical-stable", "canonical", "Canonical", "", "Canonical", "active", null, null, "{}", "{}", null, null, now, now).run();
  const insertVersion = `INSERT INTO site_agent_v2_capability_versions
    (id,site_agent_id,capability_id,version,status,implementation_json,validation_json,version_json,published_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
  await database.prepare(insertVersion).bind("canonical-existing-v1", "canonical-site", "canonical-capability", 1, "published", "{}", "{}", "{}", now, now, now).run();
  await database.prepare(insertVersion).bind("canonical-existing-v2", "canonical-site", "canonical-capability", 2, "published", "{}", "{}", "{}", now, now, now).run();
  await database.prepare(`INSERT INTO site_agent_v2_capability_projects
    (id,site_agent_id,intent_key,stable_key,contract_fingerprint,active_revision_id,latest_revision_id,status,project_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
    "canonical-project", "canonical-site", "legacy", "legacy-stable", "fingerprint", "legacy-r1", "legacy-r2", "published",
    JSON.stringify({ canonicalCapabilityId: "canonical-capability", stableKey: "legacy-stable", intentKey: "legacy", name: "Legacy", goalTemplate: "Legacy", activeRevisionId: "legacy-r1", latestRevisionId: "legacy-r2" }),
    now, now,
  ).run();
  const insertRevision = `INSERT INTO site_agent_v2_capability_revisions
    (id,project_id,site_agent_id,revision_number,status,revision_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`;
  await database.prepare(insertRevision).bind("legacy-r1", "canonical-project", "canonical-site", 1, "published", "{}", now, now).run();
  await database.prepare(insertRevision).bind("legacy-r2", "canonical-project", "canonical-site", 2, "published", "{}", now, now).run();
  await database.prepare(insertRevision).bind("canonical-existing-v2", "canonical-project", "canonical-site", 7, "published", "{}", now, now).run();
  const store = await d1CapabilityStore(database);

  const migrated = await store.backfillLegacyCapabilityCenter(database);
  assert.equal(migrated.capabilities, 0, "the explicit same-site canonical ID wins over the legacy stable key");
  assert.equal(migrated.versions, 2);
  assert.deepEqual(
    (await database.prepare(`SELECT id,version FROM site_agent_v2_capability_versions WHERE capability_id='canonical-capability' ORDER BY version`).all()).results,
    [
      { id: "canonical-existing-v1", version: 1 },
      { id: "canonical-existing-v2", version: 2 },
      { id: "legacy-r1", version: 3 },
      { id: "legacy-r2", version: 4 },
    ],
  );
  assert.equal((await database.prepare(`SELECT stable_key FROM site_agent_v2_capabilities WHERE id='canonical-capability'`).first()).stable_key, "canonical-stable");
  assert.equal((await database.prepare(`SELECT value FROM site_agent_v2_meta WHERE key='capability_center_four_table_backfill'`).first()).value, "2");
  assert.equal((await store.verifyCapabilityCenterMigration(database)).passed, true);
});

test("an orphan legacy Revision cannot be mistaken for an allowed duplicate-Project skip", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-four-table-orphan-revision-${schemaSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const schema = await freshSchemaModule();
  await schema.ensureSiteAgentV2Schema(database);
  const now = "2026-08-02T00:00:00.000Z";
  await database.prepare(`INSERT INTO site_agent_v2_capability_revisions
    (id,project_id,site_agent_id,revision_number,status,revision_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind("orphan-revision", "missing-project", "orphan-site", 1, "draft", "{}", now, now).run();
  const store = await d1CapabilityStore(database);

  await assert.rejects(
    store.backfillLegacyCapabilityCenter(database),
    /capability_center_backfill_coverage_failed:c0:d0:v1:j0:t0:s0/,
  );
  assert.equal(await database.prepare(`SELECT value FROM site_agent_v2_meta WHERE key='capability_center_four_table_backfill'`).first(), null);
});

test("the four-table verification gate reports every referential and live-identity violation", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-four-table-invalid-${schemaSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const store = await d1CapabilityStore(database);
  await store.backfillLegacyCapabilityCenter(database);
  await database.prepare(`DROP INDEX site_agent_v2_capabilities_live_identity_idx`).run();
  const now = "2026-08-02T00:00:00.000Z";
  const insertCapability = `INSERT INTO site_agent_v2_capabilities
    (id,site_agent_id,stable_key,intent_key,name,description,goal_template,status,current_version_id,latest_version_id,contract_json,capability_json,unpublished_at,deleted_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  await database.prepare(insertCapability).bind("capability-a", "invalid-site", "duplicate-key", "a", "A", "", "A", "active", "missing-current", "missing-latest", "{}", "{}", null, null, now, now).run();
  await database.prepare(insertCapability).bind("capability-b", "invalid-site", "duplicate-key", "b", "B", "", "B", "draft", null, null, "{}", "{}", null, null, now, now).run();
  await database.prepare(`INSERT INTO site_agent_v2_capability_versions
    (id,site_agent_id,capability_id,version,status,implementation_json,validation_json,version_json,published_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind("orphan-version", "invalid-site", "missing-capability", 1, "draft", "{}", "{}", "{}", null, now, now).run();
  await database.prepare(`INSERT INTO site_agent_v2_capability_tasks
    (id,site_agent_id,proposal_id,capability_id,capability_version_id,type,status,stage,task_json,result_json,evidence_json,error_json,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind("orphan-task", "invalid-site", null, "missing-capability", "orphan-version", "generate", "queued", "queued", "{}", "{}", "{}", null, null, now, now).run();
  await database.prepare(`INSERT INTO site_agent_v2_capability_proposals
    (id,site_agent_id,capability_id,duplicate_capability_id,kind,status,proposal_json,analysis_json,archived_at,deleted_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind("orphan-proposal", "invalid-site", "missing-capability", "missing-duplicate", "new", "duplicate", "{}", "{}", null, null, now, now).run();

  const verification = await store.verifyCapabilityCenterMigration(database);
  assert.equal(verification.passed, false);
  assert.equal(verification.orphanVersions, 1);
  assert.equal(verification.orphanTasks, 1);
  assert.equal(verification.orphanProposalCapabilityReferences, 1);
  assert.equal(verification.orphanProposalDuplicateReferences, 1);
  assert.equal(verification.orphanCurrentVersionPointers, 1);
  assert.equal(verification.orphanLatestVersionPointers, 1);
  assert.equal(verification.duplicateLiveStableKeys, 1);
  assert.deepEqual(new Set(verification.errors), new Set([
    "capability_center_orphan_versions",
    "capability_center_orphan_tasks",
    "capability_center_orphan_proposal_capability_references",
    "capability_center_orphan_proposal_duplicate_references",
    "capability_center_orphan_current_version_pointers",
    "capability_center_orphan_latest_version_pointers",
    "capability_center_duplicate_live_stable_keys",
  ]));
});

test("the gate rejects a marker that hides a catastrophically empty legacy backfill", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-four-table-empty-${schemaSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const store = await d1CapabilityStore(database);
  await store.backfillLegacyCapabilityCenter(database);
  const now = "2026-08-02T00:00:00.000Z";
  await database.prepare(`INSERT INTO site_agent_v2_capability_projects
    (id,site_agent_id,intent_key,stable_key,contract_fingerprint,active_revision_id,latest_revision_id,status,project_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind("late-project", "late-site", "late", "late", "late", null, null, "draft", "{}", now, now).run();
  const verification = await store.verifyCapabilityCenterMigration(database);
  assert.deepEqual(verification.legacySources, { projects: 1, revisions: 0, signals: 0, learningJobs: 0 });
  assert.equal(verification.catastrophicEmptyBackfill, true);
  assert.equal(verification.passed, false);
  assert.ok(verification.errors.includes("capability_center_catastrophic_empty_backfill"));
});

test("the production migration endpoint and runner enforce authenticated non-2xx gating", async () => {
  const [route, runner] = await Promise.all([
    source("app/api/internal/migrate-capability-center/route.ts"),
    source("scripts/run-capability-center-migration.mjs"),
  ]);
  assert.match(route, /internalMaintenanceAuthorized/);
  assert.match(route, /ensureSiteAgentV2Schema/);
  assert.match(route, /backfillLegacyCapabilityCenter\(database\)/);
  assert.match(route, /verifyCapabilityCenterMigration\(database\)/);
  assert.match(route, /verification\.passed \? 200 : 409/);
  assert.match(runner, /--schema-only/);
  assert.match(runner, /if \(!response\.ok\)/);
  assert.match(runner, /marker\?\.actual !== "2"/);
  assert.match(runner, /legacySources/);
  assert.match(runner, /catastrophicEmptyBackfill/);
  assert.match(runner, /orphanProposalCapabilityReferences/);
  assert.match(runner, /duplicateLiveStableKeys/);

  const stateKey = `__CAPABILITY_MIGRATION_ROUTE_${schemaSequence += 1}`;
  globalThis[stateKey] = {
    backfills: 0,
    schemaCalls: 0,
    v2SchemaCalls: 0,
    verification: { passed: false, marker: { expected: "2", actual: "1" }, counts: {}, orphanVersions: 0, orphanTasks: 0, orphanCurrentVersionPointers: 0, orphanLatestVersionPointers: 0, duplicateLiveStableKeys: 0, errors: ["marker"] },
  };
  try {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("app/api/internal/migrate-capability-center/route.ts", ROOT))],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: [{
        name: "migration-route-dependencies",
        setup(builder) {
          builder.onLoad({ filter: /[\\/]db[\\/]capability-center-store\.ts$/ }, () => ({
            contents: `const state=globalThis[${JSON.stringify(stateKey)}]; export async function backfillLegacyCapabilityCenter(){state.backfills+=1;return {alreadyApplied:false}} export async function verifyCapabilityCenterMigration(){return state.verification}`,
            loader: "ts",
          }));
          builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({ contents: `export function getD1Binding(){return {}}`, loader: "ts" }));
          builder.onLoad({ filter: /[\\/]db[\\/]site-agent-schema\.ts$/ }, () => ({
            contents: `const state=globalThis[${JSON.stringify(stateKey)}]; export async function ensureSiteAgentV2Schema(){state.schemaCalls+=1}`,
            loader: "ts",
          }));
          builder.onLoad({ filter: /[\\/]db[\\/]capability-center-v2-schema\.ts$/ }, () => ({
            contents: `const state=globalThis[${JSON.stringify(stateKey)}]; export async function ensureCapabilityCenterV2Schema(){state.v2SchemaCalls+=1}`,
            loader: "ts",
          }));
          builder.onLoad({ filter: /[\\/]app[\\/]api[\\/]site-agents[\\/]http\.ts$/ }, () => ({
            contents: `export async function internalMaintenanceAuthorized(request){return request.headers.get("x-sitewake-maintenance-token")==="secret"}`,
            loader: "ts",
          }));
        },
      }],
    });
    const bundledRoute = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#migration-route-${schemaSequence}`);
    const unauthorized = await bundledRoute.POST(new Request("http://localhost/api/internal/migrate-capability-center", { method: "POST" }));
    assert.equal(unauthorized.status, 401);
    assert.equal(globalThis[stateKey].backfills, 0);
    const schemaReady = await bundledRoute.POST(new Request("http://localhost/api/internal/migrate-capability-center?schema-only=1", { method: "POST", headers: { "x-sitewake-maintenance-token": "secret" } }));
    assert.equal(schemaReady.status, 200);
    assert.equal(globalThis[stateKey].schemaCalls, 1);
    assert.equal(globalThis[stateKey].v2SchemaCalls, 1);
    const rejected = await bundledRoute.POST(new Request("http://localhost/api/internal/migrate-capability-center", { method: "POST", headers: { "x-sitewake-maintenance-token": "secret" } }));
    assert.equal(rejected.status, 409);
    globalThis[stateKey].verification = { ...globalThis[stateKey].verification, passed: true, marker: { expected: "2", actual: "2" }, errors: [] };
    const accepted = await bundledRoute.POST(new Request("http://localhost/api/internal/migrate-capability-center", { method: "POST", headers: { "x-sitewake-maintenance-token": "secret" } }));
    assert.equal(accepted.status, 200);
    assert.equal(globalThis[stateKey].backfills, 2);
  } finally {
    delete globalThis[stateKey];
  }
});

test("an existing Proposal table is upgraded with archive and logical-delete lifecycle columns", async () => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-proposal-migration-${schemaSequence += 1}` },
  });
  try {
    const database = await miniflare.getD1Database("DB");
    await database.prepare(`CREATE TABLE site_agent_v2_capability_proposals (
      id text PRIMARY KEY NOT NULL,
      site_agent_id text NOT NULL,
      capability_id text,
      duplicate_capability_id text,
      kind text NOT NULL,
      status text NOT NULL,
      proposal_json text NOT NULL,
      analysis_json text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`).run();
    const now = "2026-08-01T00:00:00.000Z";
    await database.prepare(`INSERT INTO site_agent_v2_capability_proposals
      (id,site_agent_id,kind,status,proposal_json,analysis_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind("proposal-old", "atlas", "new", "submitted", "{}", "{}", now, now).run();

    const firstSchema = await freshSchemaModule();
    await firstSchema.ensureSiteAgentV2Schema(database);
    const columns = await database.prepare(`PRAGMA table_info(site_agent_v2_capability_proposals)`).all();
    assert.equal(columns.success, true);
    const names = new Set(columns.results.map((row) => row.name));
    assert.equal(names.has("archived_at"), true);
    assert.equal(names.has("deleted_at"), true);
    const preserved = await database.prepare(`SELECT id,site_agent_id,proposal_json FROM site_agent_v2_capability_proposals WHERE id=?`).bind("proposal-old").first();
    assert.deepEqual(preserved, { id: "proposal-old", site_agent_id: "atlas", proposal_json: "{}" });

    const restartedSchema = await freshSchemaModule();
    await restartedSchema.ensureSiteAgentV2Schema(database);
    const count = await database.prepare(`SELECT COUNT(*) AS count FROM site_agent_v2_capability_proposals WHERE id=?`).bind("proposal-old").first();
    assert.equal(count.count, 1);
  } finally {
    await miniflare.dispose();
  }
});

test("the immutable input and output contract belongs to Capability rather than CapabilityVersion", async () => {
  const schema = await source("db/site-agent-schema.ts");
  const capability = tableBody(schema, "capabilities");
  const version = tableBody(schema, "capability_versions");

  assert.match(
    capability,
    /(?:contract_json|capability_json)\s+text\s+NOT NULL/i,
    "Capability must own a durable JSON representation containing its description and input/output contract",
  );
  assert.match(version, /capability_id\s+text\s+NOT NULL/i);
  assert.match(version, /(?:implementation_json|version_json)\s+text\s+NOT NULL/i);
  assert.doesNotMatch(
    version,
    /(?:contract|input_schema|output_schema)_json/i,
    "a version may change implementation, but cannot redefine the capability contract",
  );
});

test("the stable acceptance specification belongs to Capability and is not copied into versions", async () => {
  const store = await capabilityStore();
  const created = await store.createCapabilityTask("stable-acceptance", {
    type: "generate",
    capability: draftContract("Stable acceptance"),
  });
  assert.equal(created.capability.acceptanceSpec.version, 1);
  assert.deepEqual(created.capability.acceptanceSpec.requiredEvidence, ["before-screenshot", "after-screenshot", "validation-video"]);
  assert.equal("acceptanceSpec" in created.version, false);
});

test("a write capability cannot let AI or legacy input disable idempotency evidence", async () => {
  const store = await capabilityStore();
  const created = await store.createCapabilityTask("write-idempotency", {
    type: "generate",
    capability: {
      ...draftContract("Submit order"),
      operation: "write",
      acceptanceSpec: {
        version: 1,
        criteria: [],
        requiredEvidence: ["before-screenshot", "after-screenshot", "validation-video"],
        sideEffectPolicy: {
          mode: "read-only",
          requiredCheckpoints: [],
          requireIdempotencyKey: false,
        },
      },
    },
  });
  assert.equal(created.capability.acceptanceSpec.sideEffectPolicy.requireIdempotencyKey, true);
  assert.equal(created.capability.acceptanceSpec.sideEffectPolicy.mode, "irreversible");
  assert.deepEqual(created.capability.acceptanceSpec.sideEffectPolicy.requiredCheckpoints, ["confirmation"]);
});

test("a deterministic initial Task id makes concurrent generate and repair application idempotent", async () => {
  const store = await capabilityStore();
  const siteAgentId = "initial-task-idempotency";
  const generateInput = {
    taskId: "capability-task:initial-generate",
    type: "generate",
    capability: draftContract("Concurrent initial capability"),
  };
  const [generatedA, generatedB] = await Promise.all([
    store.createCapabilityTask(siteAgentId, generateInput),
    store.createCapabilityTask(siteAgentId, generateInput),
  ]);
  assert.equal(generatedA.task.id, generatedB.task.id);
  assert.equal(generatedA.capability.id, generatedB.capability.id);
  assert.equal(generatedA.version.id, generatedB.version.id);

  const repairInput = {
    taskId: "capability-task:initial-repair",
    type: "repair",
    capabilityId: generatedA.capability.id,
  };
  const [repairedA, repairedB] = await Promise.all([
    store.createCapabilityTask(siteAgentId, repairInput),
    store.createCapabilityTask(siteAgentId, repairInput),
  ]);
  assert.equal(repairedA.task.id, repairedB.task.id);
  assert.equal(repairedA.version.id, repairedB.version.id);

  const [tasks, capabilities, versions] = await Promise.all([
    store.listCapabilityTasks(siteAgentId, { includeArchived: true }),
    store.listCapabilities(siteAgentId, { includeDeleted: true }),
    store.listCapabilityVersions(siteAgentId, generatedA.capability.id),
  ]);
  assert.equal(tasks.total, 2, "one generate Task and one repair Task exist");
  assert.equal(capabilities.total, 1);
  assert.equal(versions.length, 2, "concurrent repair creates only one additional Version");
});

test("D1 rolls back the losing deterministic Task batch without orphan Capability rows", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-task-idempotency-${schemaSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const store = await d1CapabilityStore(database);
  const siteAgentId = "d1-initial-task-idempotency";
  const input = {
    taskId: "capability-task:d1-initial-generate",
    type: "generate",
    capability: draftContract("D1 concurrent initial capability"),
  };
  const [first, second] = await Promise.all([
    store.createCapabilityTask(siteAgentId, input),
    store.createCapabilityTask(siteAgentId, input),
  ]);
  assert.equal(first.task.id, second.task.id);
  assert.equal(first.capability.id, second.capability.id);
  assert.equal(first.version.id, second.version.id);
  const [tasks, capabilities, versions] = await Promise.all([
    store.listCapabilityTasks(siteAgentId, { includeArchived: true }),
    store.listCapabilities(siteAgentId, { includeDeleted: true }),
    store.listCapabilityVersions(siteAgentId, first.capability.id),
  ]);
  assert.equal(tasks.total, 1);
  assert.equal(capabilities.total, 1);
  assert.equal(versions.length, 1);
});

test("D1 creates a missing deterministic Proposal Task and repeats idempotently", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-task-proposal-idempotency-${schemaSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const store = await d1CapabilityStore(database);
  const siteAgentId = "d1-proposal-task-idempotency";
  const { proposal } = await store.createCapabilityProposal(siteAgentId, {
    id: "proposal-deterministic-task", title: "Export invoices", requestedGoal: "Export invoices", sourceEpisodeId: "episode-export-invoices",
  });
  const claimed = await store.claimCapabilityProposalAnalysis(siteAgentId, proposal.id, proposal.updatedAt);
  const input = {
    taskId: "capability-task:deterministic-proposal-generate",
    type: "generate",
    proposalId: claimed.id,
    proposalFence: claimed.updatedAt,
    capability: draftContract("Export invoices"),
    proposalAnalysis: { disposition: "new", summary: "Reusable export flow" },
  };
  const first = await store.createCapabilityTask(siteAgentId, input);
  const second = await store.createCapabilityTask(siteAgentId, input);
  assert.equal(first.task.id, input.taskId);
  assert.equal(second.task.id, first.task.id);
  assert.equal(second.capability.id, first.capability.id);
  assert.equal(second.version.id, first.version.id);
  const [tasks, proposals] = await Promise.all([
    store.listCapabilityTasks(siteAgentId, { includeArchived: true }),
    store.listCapabilityProposals(siteAgentId),
  ]);
  assert.equal(tasks.total, 1);
  assert.equal(proposals.proposals.length, 1);
  assert.equal(proposals.proposals[0].status, "accepted");
  assert.equal(proposals.proposals[0].capabilityId, first.capability.id);
});

test("a stale new-analysis fence cannot write after the Proposal became duplicate", async (t) => {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `capability-proposal-fence-${schemaSequence += 1}` },
  });
  t.after(() => miniflare.dispose());
  const database = await miniflare.getD1Database("DB");
  const store = await d1CapabilityStore(database);
  const siteAgentId = "d1-mixed-disposition-fence";
  const { proposal } = await store.createCapabilityProposal(siteAgentId, {
    title: "Mixed disposition",
    requestedGoal: "Export invoices",
  });
  const claimed = await store.claimCapabilityProposalAnalysis(siteAgentId, proposal.id, proposal.updatedAt);
  await store.resolveCapabilityProposalAnalysis(siteAgentId, proposal.id, {
    status: "duplicate",
    expectedUpdatedAt: claimed.updatedAt,
    analysis: { disposition: "duplicate" },
  });

  await assert.rejects(store.createCapabilityTask(siteAgentId, {
    taskId: "capability-task:stale-new",
    type: "generate",
    proposalId: proposal.id,
    proposalFence: claimed.updatedAt,
    capability: draftContract("Stale new capability"),
    proposalAnalysis: { disposition: "new" },
  }), /capability_proposal_analysis_conflict/);

  const [tasks, capabilities, proposals] = await Promise.all([
    store.listCapabilityTasks(siteAgentId, { includeArchived: true }),
    store.listCapabilities(siteAgentId, { includeDeleted: true }),
    store.listCapabilityProposals(siteAgentId),
  ]);
  const versions = capabilities.capabilities.length
    ? await store.listCapabilityVersions(siteAgentId, capabilities.capabilities[0].id)
    : [];
  assert.equal(tasks.total, 0);
  assert.equal(capabilities.total, 0);
  assert.equal(versions.length, 0);
  assert.equal(proposals.proposals[0].status, "duplicate");
});

test("CapabilityTask records task kind, lifecycle, archive state, and exact business ownership", async () => {
  const schema = await source("db/site-agent-schema.ts");
  const task = tableBody(schema, "capability_tasks");

  for (const column of [
    "site_agent_id",
    "proposal_id",
    "capability_id",
    "capability_version_id",
    "(?:task_type|type)",
    "status",
    "task_json",
    "created_at",
    "updated_at",
    "archived_at",
  ]) {
    assert.match(task, new RegExp(`\\b${column}\\b`, "i"), column);
  }
});

test("manual review is the terminal generation step and only approval publishes the draft", async () => {
  const store = await capabilityStore();
  const siteAgentId = "four-table-review";
  await ensureSite(siteAgentId);
  const created = await store.createCapabilityTask(siteAgentId, {
    type: "generate",
    capability: draftContract("Review gated capability"),
    implementation: {
      kind: "program",
      moduleRef: { contentHash: "a".repeat(64), moduleUrl: "/modules/review.js", exportName: "capability" },
    },
    validation: {
      status: "passed",
      runId: "run-review",
      startUrl: "https://example.test/",
      validatedContentHash: "a".repeat(64),
    },
  });
  await store.updateCapabilityTaskProgress(siteAgentId, created.task.id, {
    status: "awaiting-review",
    stage: "review",
  });

  const beforeApproval = await store.getCapability(siteAgentId, created.capability.id);
  assert.equal(beforeApproval.status, "draft");
  assert.equal(beforeApproval.currentVersionId, undefined);

  await store.actOnCapabilityTask(siteAgentId, created.task.id, "approve");
  const afterApproval = await store.getCapability(siteAgentId, created.capability.id);
  assert.equal(afterApproval.status, "active");
  assert.equal(afterApproval.currentVersionId, created.version.id);
});

test("a failed initial build leaves a visible draft_failed Capability and rebuild reuses that draft", async () => {
  const store = await capabilityStore();
  const siteAgentId = "four-table-draft-failure";
  const first = await store.createCapabilityTask(siteAgentId, {
    type: "generate",
    capability: draftContract("Failed draft capability"),
  });
  await store.updateCapabilityTaskProgress(siteAgentId, first.task.id, {
    status: "failed",
    error: { code: "author_failed", summary: "authoring failed" },
  });

  const failedDraft = await store.getCapability(siteAgentId, first.capability.id);
  assert.equal(failedDraft.status, "draft_failed");

  await store.actOnCapabilityTask(siteAgentId, first.task.id, "rebuild");
  const [tasks, versions, rebuildingDraft] = await Promise.all([
    store.listCapabilityTasks(siteAgentId, { capabilityId: failedDraft.id, includeArchived: true }),
    store.listCapabilityVersions(siteAgentId, failedDraft.id),
    store.getCapability(siteAgentId, failedDraft.id),
  ]);
  const rebuilt = tasks.tasks.find((task) => task.id !== first.task.id);
  assert.ok(rebuilt, "rebuild creates a new Task and retains the failed Task as history");
  assert.equal(rebuilt.type, "generate");
  assert.equal(rebuilt.capabilityId, failedDraft.id);
  assert.notEqual(rebuilt.capabilityVersionId, first.version.id);
  assert.equal(versions[0].version, 2);
  assert.equal(rebuildingDraft.status, "draft");
});

test("an awaiting-review task can preserve legacy evidence and requeue the same version for validation", async () => {
  const store = await capabilityStore();
  const siteAgentId = "four-table-revalidate";
  const created = await store.createCapabilityTask(siteAgentId, {
    type: "generate",
    capability: draftContract("Revalidate proof"),
    validation: { status: "passed", runId: "legacy-run", startUrl: "https://example.test/" },
    evidence: { runner: { runId: "legacy-run", status: "passed" } },
  });
  await store.updateCapabilityTaskProgress(siteAgentId, created.task.id, { status: "awaiting-review", stage: "review" });
  const requeued = await store.actOnCapabilityTask(siteAgentId, created.task.id, "revalidate");
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.stage, "validate");
  assert.equal(requeued.capabilityVersionId, created.version.id);
  assert.equal(requeued.evidence.runner, undefined);
  assert.equal(requeued.evidence.validationHistory.length, 1);
  const [version] = await store.listCapabilityVersions(siteAgentId, created.capability.id);
  assert.equal(version.status, "draft");
  assert.equal(version.validation.status, "pending");
  assert.equal(version.validation.runId, undefined);
});

test("logical deletion is terminal while unpublishing remains reversible", async () => {
  const [schema, store] = await Promise.all([
    source("db/site-agent-schema.ts"),
    capabilityStore(),
  ]);
  const capability = tableBody(schema, "capabilities");
  assert.match(capability, /deleted_at\s+text/i);

  const siteAgentId = "four-table-delete";
  await ensureSite(siteAgentId);
  const created = await store.createCapabilityTask(siteAgentId, {
    type: "generate",
    capability: draftContract("Delete capability"),
  });
  await assert.rejects(
    () => store.actOnCapability(siteAgentId, created.capability.id, "delete"),
    /capability_has_active_task/,
  );
  const cancelled = await store.actOnCapabilityTask(siteAgentId, created.task.id, "cancel", {
    feedback: "Administrator stopped the build before deletion.",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error.code, "user_cancelled");
  assert.equal((await store.getCapability(siteAgentId, created.capability.id)).status, "draft_failed");
  await store.actOnCapability(siteAgentId, created.capability.id, "delete");
  assert.equal(await store.getCapability(siteAgentId, created.capability.id), undefined);
  assert.equal(
    (await store.getCapability(siteAgentId, created.capability.id, { includeDeleted: true })).status,
    "deleted",
  );
  await assert.rejects(
    () => store.actOnCapability(siteAgentId, created.capability.id, "relist"),
    /capability_deleted/,
  );
});

test("an unpublished formal Capability can be relisted with the same immutable contract", async () => {
  const store = await capabilityStore();
  const siteAgentId = "four-table-unpublish";
  await ensureSite(siteAgentId);
  const created = await store.createCapabilityTask(siteAgentId, {
    type: "generate",
    capability: draftContract("Relist capability"),
    implementation: {
      kind: "program",
      moduleRef: { contentHash: "b".repeat(64), moduleUrl: "/modules/relist.js", exportName: "capability" },
    },
    validation: {
      status: "passed",
      runId: "run-relist",
      startUrl: "https://example.test/",
      validatedContentHash: "b".repeat(64),
    },
  });
  await store.updateCapabilityTaskProgress(siteAgentId, created.task.id, {
    status: "awaiting-review",
    stage: "review",
  });
  await store.actOnCapabilityTask(siteAgentId, created.task.id, "approve");

  const unpublished = await store.actOnCapability(siteAgentId, created.capability.id, "unpublish");
  assert.equal(unpublished.status, "unpublished");
  const relisted = await store.actOnCapability(siteAgentId, created.capability.id, "relist");
  assert.equal(relisted.status, "active");
  assert.deepEqual(relisted.inputSchema, created.capability.inputSchema);
  assert.deepEqual(relisted.outputSchema, created.capability.outputSchema);
});

test("ordinary user execution never writes CapabilityTask records", async () => {
  const [agentRuns, browserClient] = await Promise.all([
    source("db/agent-run-store.ts"),
    source("client/user-agent-port.ts"),
  ]);

  assert.doesNotMatch(agentRuns, /capability_tasks/i);
  assert.doesNotMatch(browserClient, /capability_tasks/i);
});

test("a duplicate analysis persists only a Proposal and never creates a CapabilityTask", async () => {
  const store = await capabilityStore();
  const siteAgentId = "four-table-duplicate-proposal";
  const existing = await store.createCapabilityTask(siteAgentId, {
    type: "generate",
    capability: draftContract("Open the existing home page"),
  });
  const { proposal } = await store.createCapabilityProposal(siteAgentId, {
    title: "Duplicate request",
    requestedGoal: "Open the existing home page",
  });
  const initialStatus = proposal.status;
  const claimed = await store.claimCapabilityProposalAnalysis(siteAgentId, proposal.id, proposal.updatedAt);
  const claimedStatus = claimed.status;
  const duplicate = await store.resolveCapabilityProposalAnalysis(siteAgentId, proposal.id, {
    status: "duplicate",
    expectedUpdatedAt: claimed.updatedAt,
    duplicateCapabilityId: existing.capability.id,
    analysis: { disposition: "duplicate", evidence: ["stable-goal-exact-match"] },
  });
  const [proposals, tasks] = await Promise.all([
    store.listCapabilityProposals(siteAgentId),
    store.listCapabilityTasks(siteAgentId),
  ]);

  assert.equal(initialStatus, "pending");
  assert.equal(claimedStatus, "analyzing");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(proposals.proposals.length, 1);
  assert.equal(proposals.proposals[0].duplicateCapabilityId, existing.capability.id);
  assert.equal(tasks.tasks.filter((task) => task.proposalId === proposal.id).length, 0);
});
