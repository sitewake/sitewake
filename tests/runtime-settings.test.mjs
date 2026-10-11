/**
 * `runtime_settings` is the console's global key/value store. Covered here:
 * the real D1 round trip (lazy schema, upsert), the Postgres translation of
 * that SQL, memory mode when no database is bound, and the `.env.local`
 * write-back that keeps a local `npm run dev` configuration across restarts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let sequence = 0;

async function isolatedD1Database() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `runtime-settings-${sequence += 1}` },
  });
  return { database: await miniflare.getD1Database("DB"), dispose: () => miniflare.dispose() };
}

/** Bundles the store (its `db/index.ts` import is type-only, so nothing of the runtime comes along). */
async function loadStore() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../db/runtime-settings-store.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

test("D1: the table is created on first use and a key is upserted in place", async () => {
  const { database, dispose } = await isolatedD1Database();
  try {
    const store = await loadStore();
    assert.equal(await store.getRuntimeSetting("model", database), null, "an empty store reads as absent, without a bootstrap error");
    const first = await store.putRuntimeSetting("model", { apiKey: "sk-first", model: "m1" }, database, "console");
    assert.equal(first.key, "model");
    assert.equal(first.updatedBy, "console");
    const read = await store.getRuntimeSetting("model", database);
    assert.deepEqual(read.value, { apiKey: "sk-first", model: "m1" });
    assert.equal(read.updatedAt, first.updatedAt);

    await store.putRuntimeSetting("model", { apiKey: "sk-second", model: "m2" }, database);
    const rows = await database.prepare(`SELECT key, value_json, updated_by FROM runtime_settings`).all();
    assert.equal(rows.results.length, 1, "the same key replaces its row rather than adding one");
    assert.deepEqual(JSON.parse(rows.results[0].value_json), { apiKey: "sk-second", model: "m2" });
    assert.equal(rows.results[0].updated_by, null);
  } finally { await dispose(); }
});

test("D1: keys are independent and the schema bootstrap runs once per database", async () => {
  const { database, dispose } = await isolatedD1Database();
  try {
    let creates = 0;
    const counting = {
      prepare: (sql) => { if (/CREATE TABLE/i.test(sql)) creates += 1; return database.prepare(sql); },
      batch: (statements) => database.batch(statements),
    };
    const store = await loadStore();
    await store.putRuntimeSetting("a", 1, counting);
    await store.putRuntimeSetting("b", "two", counting);
    assert.equal((await store.getRuntimeSetting("a", counting)).value, 1);
    assert.equal((await store.getRuntimeSetting("b", counting)).value, "two");
    assert.equal(creates, 1);
  } finally { await dispose(); }
});

test("Postgres: the upsert translates to ON CONFLICT on the primary key", async () => {
  const { postgresSql } = await import("../db/postgres-adapter.ts");
  const sql = postgresSql(`INSERT OR REPLACE INTO runtime_settings (key,value_json,updated_at,updated_by) VALUES (?,?,?,?)`);
  assert.match(sql, /^INSERT INTO runtime_settings \(key,value_json,updated_at,updated_by\) VALUES \(\$1,\$2,\$3,\$4\) ON CONFLICT \(key\) DO UPDATE SET value_json=EXCLUDED\.value_json,updated_at=EXCLUDED\.updated_at,updated_by=EXCLUDED\.updated_by$/);
});

test("Postgres: read and write go through the adapter statement shape", async () => {
  const calls = [];
  const fake = {
    dialect: "postgres",
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) { statement.values = values; return statement; },
        async run() { calls.push({ sql, values: statement.values }); return { success: true, results: [] }; },
        async all() {
          calls.push({ sql, values: statement.values });
          return { success: true, results: [{ key: "model", value_json: JSON.stringify({ model: "m" }), updated_at: "2026-09-19T00:00:00.000Z", updated_by: "console" }] };
        },
      };
      return statement;
    },
    async batch(statements) { calls.push({ batch: statements.length }); return statements.map(() => ({ success: true })); },
  };
  const store = await loadStore();
  await store.putRuntimeSetting("model", { model: "m" }, fake, "console");
  const read = await store.getRuntimeSetting("model", fake);
  assert.deepEqual(read, { key: "model", value: { model: "m" }, updatedAt: "2026-09-19T00:00:00.000Z", updatedBy: "console" });
  assert.deepEqual(calls[0], { batch: 1 }, "schema first");
  assert.match(calls[1].sql, /INSERT OR REPLACE INTO runtime_settings/);
  assert.deepEqual(calls[1].values.slice(0, 2), ["model", JSON.stringify({ model: "m" })]);
  assert.equal(calls[1].values[3], "console");
  assert.match(calls[2].sql, /SELECT key,value_json,updated_at,updated_by FROM runtime_settings WHERE key=\?/);
  assert.deepEqual(calls[2].values, ["model"]);
});

test("a failed statement surfaces as an error instead of a silent null", async () => {
  const failing = {
    prepare: () => ({ bind() { return this; }, async run() { return { success: false, error: "disk full" }; }, async all() { return { success: false, error: "disk full" }; } }),
    async batch(statements) { return statements.map(() => ({ success: true })); },
  };
  const store = await loadStore();
  await assert.rejects(store.putRuntimeSetting("model", {}, failing), /disk full/);
  await assert.rejects(store.getRuntimeSetting("model", failing), /disk full/);
});

test("memory mode: without a database the setting lives in the process", async () => {
  const store = await loadStore();
  assert.equal(await store.getRuntimeSetting("model", null), null);
  const saved = await store.putRuntimeSetting("model", { apiKey: "sk-mem" }, null, "console");
  assert.deepEqual(await store.getRuntimeSetting("model", null), saved);
  store.resetRuntimeSettingsMemory();
  assert.equal(await store.getRuntimeSetting("model", null), null);
});

test("write-back is only for a local `npm run dev` without a database", async () => {
  const store = await loadStore();
  const previous = process.env.SITEWAKE_LOCAL_DEV;
  try {
    delete process.env.SITEWAKE_LOCAL_DEV;
    assert.equal(store.localEnvWritebackEnabled(null), false);
    process.env.SITEWAKE_LOCAL_DEV = "1";
    assert.equal(store.localEnvWritebackEnabled(null), true);
    assert.equal(store.localEnvWritebackEnabled({ prepare() {}, batch() {} }), false, "a bound database is the durable store");
  } finally {
    if (previous === undefined) delete process.env.SITEWAKE_LOCAL_DEV; else process.env.SITEWAKE_LOCAL_DEV = previous;
  }
});

test("applyEnvValues rewrites only the target keys and leaves every other line as it was", async () => {
  const { applyEnvValues } = await loadStore();
  const before = [
    "# keep this comment",
    "PORT=3000",
    "MODEL_API_KEY=sk-old",
    "export MODEL=old-model",
    "MODEL_API_KEY=sk-duplicate",
    "  OTHER = 'spaced value' ",
    "",
  ].join("\n");
  const after = applyEnvValues(before, { MODEL_API_KEY: "sk-new", MODEL: "new model", MODEL_BASE_URL: "https://api.example.com/v1" });
  assert.equal(after, [
    "# keep this comment",
    "PORT=3000",
    "MODEL_API_KEY=sk-new",
    "MODEL='new model'",
    "  OTHER = 'spaced value' ",
    "",
    "# Written by the console (model settings).",
    "MODEL_BASE_URL=https://api.example.com/v1",
    "",
  ].join("\n"));
  assert.equal(applyEnvValues("", { MODEL: "m" }), "# Written by the console (model settings).\nMODEL=m\n");
  assert.throws(() => applyEnvValues("", { MODEL: "a\nb" }), /env_value_newline/);
});

test("writeEnvValues creates or updates the file atomically with 0600 and no temp file left behind", async () => {
  const { writeEnvValues } = await loadStore();
  const dir = await mkdtemp(join(tmpdir(), "sitewake-runtime-settings-"));
  try {
    const path = join(dir, ".env.local");
    await writeEnvValues({ MODEL_API_KEY: "sk-1", MODEL: "m1" }, path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readFile(path, "utf8"), "# Written by the console (model settings).\nMODEL_API_KEY=sk-1\nMODEL=m1\n");

    await writeFile(path, "PORT=3001\nMODEL_API_KEY=sk-1\nMODEL=m1\n");
    await writeEnvValues({ MODEL_API_KEY: "sk-2" }, path);
    assert.equal(await readFile(path, "utf8"), "PORT=3001\nMODEL_API_KEY=sk-2\nMODEL=m1\n");

    await assert.rejects(writeEnvValues({ MODEL: "bad\nvalue" }, path), /env_value_newline/);
    assert.equal(await readFile(path, "utf8"), "PORT=3001\nMODEL_API_KEY=sk-2\nMODEL=m1\n", "a failed write leaves the file intact");
    assert.deepEqual(await readdir(dir), [".env.local"], "no temporary file remains");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
