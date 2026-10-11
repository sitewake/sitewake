import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entryPoint = resolve(root, "tests/helpers/capability-v2-d1-transaction-entry.ts");
let bundlePromise;

class SqliteD1Fixture {
  constructor() {
    this.dialect = "d1";
    this.sqlite = new DatabaseSync(":memory:");
    this.failVersionInsert = true;
  }

  prepare(sql) {
    const database = this;
    let values = [];
    return {
      __sql: sql,
      bind(...bound) {
        values = bound;
        return this;
      },
      run() {
        if (database.failVersionInsert && /^\s*INSERT\s+INTO\s+ccv2_capability_versions/iu.test(sql)) {
          throw new Error("d1_fixture_version_insert_failed");
        }
        try {
          const result = database.sqlite.prepare(sql).run(...values);
          return { success: true, meta: { changes: Number(result.changes || 0), last_row_id: Number(result.lastInsertRowid || 0) } };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
      all() {
        try {
          const results = database.sqlite.prepare(sql).all(...values);
          return { success: true, results };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    };
  }

  async batch(statements) {
    if (this.raceNextPublish && statements.some(statement => statement.__sql.startsWith("UPDATE ccv2_capabilities SET name="))) {
      this.raceNextPublish = false;
      this.sqlite.exec("INSERT INTO ccv2_capability_versions SELECT 'raced-version',site_id,capability_id,source,program_json,status,review_json,created_at,updated_at,published_at,deleted_at FROM ccv2_capability_versions LIMIT 1");
      this.sqlite.exec("UPDATE ccv2_capabilities SET current_version_id='raced-version'");
    }
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => { const result = statement.run(); if (!result.success) throw new Error(result.error); return result; });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  withSession() {
    return this;
  }
}

async function loadBundle() {
  bundlePromise ||= build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    write: false,
    plugins: [{
      name: "capability-v2-d1-index-fixture",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^\.?\.?\/index(?:\.ts)?$/ }, (args) => /[\\/]db[\\/]/.test(args.importer) ? ({ path: "capability-v2-d1-index-fixture", namespace: "capability-v2-d1" }) : undefined);
        buildApi.onResolve({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({ path: "capability-v2-d1-index-fixture", namespace: "capability-v2-d1" }));
        buildApi.onLoad({ filter: /.*/, namespace: "capability-v2-d1" }, () => ({
          loader: "js",
          contents: `const database = globalThis.__capabilityV2D1Database; if (!database) throw new Error("d1_fixture_binding_missing"); export function getD1Binding(){return database;} export function getArtifactBinding(){return null;} export class D1UnavailableError extends Error {}`,
        }));
      },
    }],
  });
  const result = await bundlePromise;
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

export async function runD1TransactionRollbackFixture() {
  const database = new SqliteD1Fixture();
  globalThis.__capabilityV2D1Database = database;
  try {
    const bundle = await loadBundle();
    return await bundle.runD1TransactionRollbackFixture();
  } finally {
    delete globalThis.__capabilityV2D1Database;
    database.sqlite.close();
  }
}

export async function runD1PublicationRecoveryFixture() {
  const database = new SqliteD1Fixture();
  database.failVersionInsert = false;
  globalThis.__capabilityV2D1Database = database;
  try {
    const bundle = await loadBundle();
    const initial = await bundle.runD1TransactionRollbackFixture();
    if (initial.published.outcome !== "Published") throw new Error("initial_publication_failed");
    const upgrade = await bundle.runD1TransactionRollbackFixture({ baseVersionId: initial.published.version.id, suffix: "升级" });
    if (upgrade.published.outcome !== "Published") throw new Error("upgrade_publication_failed:" + JSON.stringify(upgrade.published));
    database.raceNextPublish = true;
    const raced = await bundle.runD1TransactionRollbackFixture({ baseVersionId: upgrade.published.version.id, suffix: "并发变更" });
    return { initial, upgrade, raced, versions: database.sqlite.prepare("SELECT id FROM ccv2_capability_versions").all(), current: database.sqlite.prepare("SELECT current_version_id FROM ccv2_capabilities").get() };
  } finally { delete globalThis.__capabilityV2D1Database; database.sqlite.close(); }
}
