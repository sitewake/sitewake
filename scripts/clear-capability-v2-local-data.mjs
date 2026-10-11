import { readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

async function findSqliteFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findSqliteFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".sqlite")) files.push(entryPath);
  }
  return files;
}

function normalizeProjectRoot(projectRoot) {
  return resolve(projectRoot instanceof URL ? fileURLToPath(projectRoot) : projectRoot);
}

/**
 * Deletes only Capability Center V2 rows from this project's local D1 state.
 * Legacy capability-center, Agent, knowledge and demo data remain untouched.
 */
export async function clearCapabilityV2LocalData(projectRoot = new URL("../", import.meta.url)) {
  const root = normalizeProjectRoot(projectRoot);
  const d1Root = resolve(root, ".wrangler", "state", "v3", "d1");
  const sqliteFiles = await findSqliteFiles(d1Root);
  const databases = [];

  for (const sqliteFile of sqliteFiles) {
    if (!sqliteFile.startsWith(`${d1Root}${sep}`)) throw new Error(`refusing_to_clear_outside_local_d1:${sqliteFile}`);
    const database = new DatabaseSync(sqliteFile);
    const tables = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name LIKE 'ccv2\\_%' ESCAPE '\\'
      ORDER BY name
    `).all().map(({ name }) => String(name));
    let deletedRows = 0;

    database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
    try {
      for (const table of tables) {
        const quoted = `"${table.replaceAll('"', '""')}"`;
        deletedRows += Number(database.prepare(`DELETE FROM ${quoted}`).run().changes);
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      database.close();
      throw error;
    }
    database.exec("PRAGMA foreign_keys = ON;");
    database.close();
    databases.push({ sqliteFile, clearedTables: tables, deletedRows });
  }

  return { d1Root, databases };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await clearCapabilityV2LocalData();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
