import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../db/capability-center-v2-schema.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const schema = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("PostgreSQL capability center schema migration avoids PRAGMA and safely adds archived_at", async () => {
  const preparedSql = [];
  const runSql = [];
  const database = {
    dialect: "postgres",
    prepare(sql) {
      preparedSql.push(sql);
      return {
        bind() { return this; },
        async run() {
          runSql.push(sql);
          return { success: true };
        },
        async all() {
          throw new Error(`PostgreSQL schema migration must not inspect SQLite metadata: ${sql}`);
        },
      };
    },
    async batch(statements) {
      return statements.map(() => ({ success: true }));
    },
  };

  await schema.ensureCapabilityCenterV2Schema(database);

  assert.equal(preparedSql.some((sql) => /PRAGMA\s+table_info/i.test(sql)), false);
  assert.ok(runSql.includes("ALTER TABLE ccv2_capability_tasks ADD COLUMN IF NOT EXISTS archived_at text"));
  assert.ok(runSql.includes("CREATE INDEX IF NOT EXISTS ccv2_tasks_archive_idx ON ccv2_capability_tasks (site_id, archived_at, updated_at)"));
});
