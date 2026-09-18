import pg from "pg";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
const databaseUrl = process.env.DATABASE_URL;
if (!accountId || !apiToken || !databaseId || !databaseUrl) throw new Error("Cloudflare D1 and PostgreSQL coordinates are required");

const retainedTables = [
  "site_agent_v2_agents",
  "site_agent_v2_connections",
  "site_agent_v2_observations",
  "site_agent_v2_episodes",
  "site_agent_v2_artifacts",
  "site_agent_v2_releases",
  "site_agent_v2_program_modules",
  // Retain both sides of the staged Capability Center cutover. Legacy rows
  // are immutable backfill sources; already-migrated four-table rows may also
  // exist in D1 when a deployment is resumed or replayed.
  "site_agent_v2_capability_projects",
  "site_agent_v2_capability_revisions",
  "site_agent_v2_capability_signals",
  "site_agent_v2_learning_jobs",
  "site_agent_v2_capabilities",
  "site_agent_v2_capability_versions",
  "site_agent_v2_capability_proposals",
  "site_agent_v2_capability_tasks",
  // Placement policy is durable configuration. Runtime instances and leases
  // are intentionally rebuilt during cutover, but the default pool and
  // exclusive site bindings must survive a D1 -> PostgreSQL migration.
  "site_agent_v2_runner_pools",
  "site_agent_v2_runner_placement_bindings",
];

async function d1(sql, params = []) {
  let lastFailure;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
    const payload = await response.json();
    if (response.ok && payload.success !== false && payload.result?.[0]?.success !== false) return payload.result?.[0]?.results || [];
    lastFailure = new Error(`d1_query_failed:${response.status}:${JSON.stringify(payload.errors || payload.result?.[0]?.error || payload)}`);
    if (response.status !== 429) throw lastFailure;
    await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
  }
  throw lastFailure;
}

function identifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function d1TableSnapshot(table) {
  const [row] = await d1(`SELECT COUNT(*) AS count,MAX(rowid) AS max_rowid FROM ${identifier(table)}`);
  const count = Number(row?.count || 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`d1_migration_source_count_invalid:${table}`);
  return { count, maxRowid: row?.max_rowid == null ? null : String(row.max_rowid) };
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const existing = new Set((await d1("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'site_agent_v2_%'" )).map((row) => row.name));
  const report = [];
  for (const table of retainedTables.filter((name) => existing.has(name))) {
    const sourceBefore = await d1TableSnapshot(table);
    const primaryKeys = (await d1(`PRAGMA table_info(${identifier(table)})`))
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name);
    if (!primaryKeys.length) throw new Error(`d1_migration_source_primary_key_missing:${table}`);
    const targetColumns = new Set((await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table])).rows.map((row) => row.column_name));
    if (!targetColumns.size) throw new Error(`d1_migration_target_table_missing:${table}`);
    if (primaryKeys.some((column) => !targetColumns.has(column))) throw new Error(`d1_migration_target_primary_key_missing:${table}`);
    let offset = 0;
    let inserted = 0;
    let targetWins = 0;
    let processed = 0;
    while (true) {
      // D1 rows can contain large DOM/episode JSON payloads. Tiny batches keep
      // the source isolate below its memory ceiling; PostgreSQL still commits
      // each batch transactionally and the migration remains idempotent.
      const batchSize = Math.max(1, Math.min(50, Number(process.env.D1_MIGRATION_BATCH_SIZE || 10)));
      const rows = await d1(`SELECT * FROM ${table} ORDER BY rowid LIMIT ${batchSize} OFFSET ?`, [offset]);
      if (!rows.length) break;
      await client.query("BEGIN");
      try {
        let batchInserted = 0;
        let batchTargetWins = 0;
        for (const row of rows) {
          const columns = Object.keys(row).filter((column) => targetColumns.has(column));
          const identifiers = columns.map(identifier).join(",");
          const placeholders = columns.map((_, index) => `$${index + 1}`).join(",");
          const result = await client.query(`INSERT INTO ${identifier(table)} (${identifiers}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, columns.map((column) => row[column]));
          if (result.rowCount === 1) {
            batchInserted += 1;
          } else {
            const primaryKeyWhere = primaryKeys.map((column, index) => `${identifier(column)}=$${index + 1}`).join(" AND ");
            const target = await client.query(
              `SELECT 1 FROM ${identifier(table)} WHERE ${primaryKeyWhere} LIMIT 1`,
              primaryKeys.map((column) => row[column]),
            );
            if (target.rowCount !== 1) throw new Error(`d1_migration_conflict_without_source_primary_key:${table}`);
            batchTargetWins += 1;
          }
        }
        await client.query("COMMIT");
        inserted += batchInserted;
        targetWins += batchTargetWins;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      processed += rows.length;
      offset += rows.length;
      if (rows.length < batchSize) break;
    }
    const sourceAfter = await d1TableSnapshot(table);
    if (sourceAfter.count !== sourceBefore.count || sourceAfter.maxRowid !== sourceBefore.maxRowid) {
      throw new Error(`d1_migration_source_changed:${table}`);
    }
    if (processed !== sourceBefore.count || inserted + targetWins !== sourceBefore.count) {
      throw new Error(`d1_migration_reconciliation_failed:${table}`);
    }
    report.push({ table, sourceCount: sourceBefore.count, inserted, targetWins, maxRowid: sourceBefore.maxRowid });
  }
  console.log(JSON.stringify({ status: "completed", tables: report }, null, 2));
} finally {
  await client.end();
}
