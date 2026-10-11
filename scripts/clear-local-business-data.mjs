import { readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

async function findSqliteFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
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
 * Clears local application data while preserving Wrangler and schema metadata.
 * This intentionally targets only SQLite files below this project's local D1 state.
 */
export async function clearLocalBusinessData(projectRoot = new URL("../", import.meta.url)) {
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
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_cf_%'
        AND name NOT LIKE '%_meta'
      ORDER BY name
    `).all().map(({ name }) => String(name));
    let deletedRows = 0;

    database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
    try {
      for (const table of tables) {
        const quoted = `"${table.replaceAll('"', '""')}"`;
        deletedRows += Number(database.prepare(`DELETE FROM ${quoted}`).run().changes);
      }
      const hasSequence = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get();
      if (hasSequence) database.exec("DELETE FROM sqlite_sequence;");
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      database.close();
      throw error;
    }
    database.exec("PRAGMA foreign_keys = ON;");
    database.close();
    databases.push({ sqliteFile, clearedTables: tables.length, deletedRows });
  }

  return { d1Root, databases };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await clearLocalBusinessData();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
