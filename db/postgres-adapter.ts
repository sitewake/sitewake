import { Pool, type PoolClient, type QueryResult } from "pg";
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from "./index";

const conflictKeys: Record<string, string[]> = {
  site_agent_v2_meta: ["key"],
  site_agent_v2_artifact_chunks: ["artifact_id", "sequence"],
  site_agent_v2_program_modules: ["content_hash"],
  // Composite primary key. Without this the `INSERT OR REPLACE` upsert would
  // target `ON CONFLICT (site_agent_id)`, for which no unique constraint exists,
  // so the write fails on Postgres. (On SQLite/D1 `INSERT OR REPLACE` is native.)
  site_agent_v2_knowledge: ["site_agent_id", "version"],
  // Composite PK (site, normalized query) — same reason as above; without it the cached
  // AI gap verdict silently never persists on Postgres and every gap stays "AI judging…".
  site_agent_v2_gap_verdicts: ["site_agent_id", "query_norm"],
  // Consolidated answer routes (supersedes the two above). Same composite-PK upsert hazard.
  site_agent_v2_answer_routes: ["site_agent_id", "query_norm"],
  // Crawl observation records, one row per URL, overwritten per crawl. Composite PK
  // too — without it the cross-time baseline silently never persists on Postgres, and
  // that layer fails without a sound.
  site_agent_v2_page_observations: ["site_agent_id", "url"],
};

function placeholders(sql: string) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export function postgresSql(input: string) {
  let sql = input
    .replace(/\bblob\b/gi, "bytea")
    .replace(/datetime\('now'\)/gi, "to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
    .replace(/json_extract\(([^,]+),\s*'\$\.([^']+)'\)/gi, (_match, value, path) => `(${value}::jsonb #>> '{${String(path).replace(/\./g, ",")}}')`);
  sql = sql.replace(/\bAS\s+([a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*)\b/g, (_match, alias) => `AS "${alias}"`);

  const ignore = sql.match(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i);
  if (ignore) sql = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO") + " ON CONFLICT DO NOTHING";

  const replace = sql.match(/^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+([\w]+)\s*\(([^)]+)\)/i);
  if (replace) {
    const table = replace[1];
    const columns = replace[2].split(",").map((column) => column.trim());
    const keys = conflictKeys[table] || [columns[0]];
    const updates = columns.filter((column) => !keys.includes(column)).map((column) => `${column}=EXCLUDED.${column}`);
    sql = sql.replace(/INSERT\s+OR\s+REPLACE\s+INTO/i, "INSERT INTO");
    sql += ` ON CONFLICT (${keys.join(",")}) DO UPDATE SET ${updates.join(",")}`;
  }
  return placeholders(sql);
}

class PostgresStatement implements D1PreparedStatementLike {
  values: unknown[] = [];
  readonly pool: Pool | PoolClient;
  readonly sql: string;
  constructor(pool: Pool | PoolClient, sql: string) { this.pool = pool; this.sql = sql; }
  bind(...values: unknown[]) { this.values = values; return this; }
  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> { return this.execute<T>(); }
  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> { return this.execute<T>(); }
  private async execute<T>(): Promise<D1ResultLike<T>> {
    try {
      const result = await this.pool.query(postgresSql(this.sql), this.values) as QueryResult<T & Record<string, unknown>>;
      return { success: true, results: result.rows, meta: { changes: result.rowCount || 0 } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), results: [] };
    }
  }
}

class PostgresD1Adapter implements D1DatabaseLike {
  readonly dialect = "postgres" as const;
  readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }
  prepare(sql: string) { return new PostgresStatement(this.pool, sql); }
  async batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<Array<D1ResultLike<T>>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const results: Array<D1ResultLike<T>> = [];
      for (const statement of statements as PostgresStatement[]) {
        const result = await client.query(postgresSql(statement.sql), statement.values);
        results.push({ success: true, results: result.rows as T[], meta: { changes: result.rowCount || 0 } });
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

let adapter: PostgresD1Adapter | undefined;
export function createPostgresD1Adapter(connectionString: string): D1DatabaseLike {
  adapter ||= new PostgresD1Adapter(new Pool({ connectionString, max: Number(process.env.POSTGRES_POOL_SIZE || 5), idleTimeoutMillis: 30_000 }));
  return adapter;
}
