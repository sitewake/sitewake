import type { D1DatabaseLike } from "./index";

/**
 * V2 owns these tables. They intentionally use a separate prefix from the
 * historical capability-center tables; provisioning a Site creates an empty
 * V2 space and never backfills old records.
 */
export const CAPABILITY_CENTER_V2_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ccv2_capabilities (
    id text PRIMARY KEY NOT NULL,
    site_id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    aliases_json text NOT NULL,
    search_text text NOT NULL,
    contract_json text NOT NULL,
    status text NOT NULL,
    current_version_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ccv2_capabilities_live_name_idx
    ON ccv2_capabilities (site_id, name) WHERE status <> 'Deleted'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ccv2_capabilities_live_name_normalized_idx
    ON ccv2_capabilities (site_id, lower(name)) WHERE status <> 'Deleted'`,
  `CREATE INDEX IF NOT EXISTS ccv2_capabilities_search_idx
    ON ccv2_capabilities (site_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS ccv2_capability_versions (
    id text PRIMARY KEY NOT NULL,
    site_id text NOT NULL,
    capability_id text NOT NULL,
    source text NOT NULL,
    program_json text NOT NULL,
    status text NOT NULL,
    review_json text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    published_at text,
    deleted_at text
  )`,
  `CREATE INDEX IF NOT EXISTS ccv2_versions_capability_idx
    ON ccv2_capability_versions (site_id, capability_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS ccv2_capability_tasks (
    id text PRIMARY KEY NOT NULL,
    site_id text NOT NULL,
    version_id text NOT NULL,
    type text NOT NULL,
    status text NOT NULL,
    goal text NOT NULL,
    guidance text,
    input_json text NOT NULL,
    run_spec_json text,
    runner_id text,
    result_json text,
    error_json text,
    source_agent_run_id text,
    rerun_of_task_id text,
    created_at text NOT NULL,
    started_at text,
    updated_at text NOT NULL,
    finished_at text,
    archived_at text,
    deleted_at text
  )`,
  `CREATE INDEX IF NOT EXISTS ccv2_tasks_queue_idx
    ON ccv2_capability_tasks (site_id, status, runner_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS ccv2_tasks_capability_idx
    ON ccv2_capability_tasks (site_id, version_id, updated_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ccv2_tasks_experience_once_idx
    ON ccv2_capability_tasks (site_id, source_agent_run_id, type)
    WHERE source_agent_run_id IS NOT NULL AND rerun_of_task_id IS NULL`,
  `CREATE TABLE IF NOT EXISTS ccv2_settings (
    id text PRIMARY KEY NOT NULL,
    site_id text NOT NULL,
    setting_key text NOT NULL,
    setting_value_json text NOT NULL,
    updated_by text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ccv2_settings_site_key_idx
    ON ccv2_settings (site_id, setting_key)`,
  `CREATE TABLE IF NOT EXISTS ccv2_runner_instances (
    id text PRIMARY KEY NOT NULL,
    site_id text NOT NULL,
    task_id text,
    runtime_type text NOT NULL,
    runtime_provider text NOT NULL,
    runtime_version text NOT NULL,
    status text NOT NULL,
    heartbeat_at text NOT NULL,
    heartbeat_expires_at text NOT NULL,
    last_error text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    terminated_at text
  )`,
  `CREATE INDEX IF NOT EXISTS ccv2_runner_instances_status_idx
    ON ccv2_runner_instances (site_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS ccv2_idempotency (
    site_id text NOT NULL,
    scope text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    response_json text,
    created_at text NOT NULL,
    expires_at text NOT NULL,
    PRIMARY KEY (site_id, scope, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS ccv2_idempotency_expiry_idx
    ON ccv2_idempotency (expires_at)`,
  `CREATE TABLE IF NOT EXISTS ccv2_artifacts (
    id text PRIMARY KEY NOT NULL,
    site_id text NOT NULL,
    task_id text NOT NULL,
    kind text NOT NULL,
    storage_key text NOT NULL,
    content_type text NOT NULL,
    size integer NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ccv2_artifacts_task_idx
    ON ccv2_artifacts (site_id, task_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS ccv2_candidate_artifacts (
    candidate_id text PRIMARY KEY NOT NULL,
    site_id text NOT NULL,
    generation_task_id text NOT NULL,
    artifact_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ccv2_candidate_artifacts_task_idx
    ON ccv2_candidate_artifacts (site_id, generation_task_id)`,
  `CREATE TABLE IF NOT EXISTS ccv2_classification_reservations (
    site_id text NOT NULL,
    generation_task_id text NOT NULL,
    candidate_name text NOT NULL,
    reservation_hash text NOT NULL,
    status text NOT NULL,
    capability_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    PRIMARY KEY (site_id, generation_task_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ccv2_classification_reservation_name_idx
    ON ccv2_classification_reservations (site_id, candidate_name, status)`,
  `CREATE TABLE IF NOT EXISTS ccv2_program_modules (
    site_id text NOT NULL,
    content_hash text NOT NULL,
    source_text text NOT NULL,
    storage_key text NOT NULL,
    size integer NOT NULL,
    created_at text NOT NULL,
    PRIMARY KEY (site_id, content_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS ccv2_program_modules_created_idx
    ON ccv2_program_modules (site_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS ccv2_task_events (
    id text PRIMARY KEY NOT NULL,
    site_id text NOT NULL,
    task_id text NOT NULL,
    sequence integer NOT NULL,
    event_type text NOT NULL,
    payload_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ccv2_task_events_sequence_idx
    ON ccv2_task_events (site_id, task_id, sequence)`,
] as const;

const initialized = new WeakMap<object, Promise<void>>();

export async function ensureCapabilityCenterV2Schema(database: D1DatabaseLike) {
  const cached = initialized.get(database as object);
  if (cached) return cached;
  const promise = (async () => {
    const results = await database.batch(
      CAPABILITY_CENTER_V2_SCHEMA_STATEMENTS.map((statement) => database.prepare(statement)),
    );
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "capability_center_v2_schema_failed");
    if (database.dialect === "postgres") {
      const migration = await database.prepare(`ALTER TABLE ccv2_capability_tasks ADD COLUMN IF NOT EXISTS archived_at text`).run();
      if (!migration.success) throw new Error(migration.error || "capability_center_v2_task_archive_migration_failed");
    } else {
      const taskColumns = await database.prepare(`PRAGMA table_info(ccv2_capability_tasks)`).all<{ name: string }>();
      if (!taskColumns.success) throw new Error(taskColumns.error || "capability_center_v2_task_schema_inspection_failed");
      if (!(taskColumns.results || []).some((column) => column.name === "archived_at")) {
        const migration = await database.prepare(`ALTER TABLE ccv2_capability_tasks ADD COLUMN archived_at text`).run();
        if (!migration.success) throw new Error(migration.error || "capability_center_v2_task_archive_migration_failed");
      }
    }
    const archiveIndex = await database.prepare(`CREATE INDEX IF NOT EXISTS ccv2_tasks_archive_idx ON ccv2_capability_tasks (site_id, archived_at, updated_at)`).run();
    if (!archiveIndex.success) throw new Error(archiveIndex.error || "capability_center_v2_task_archive_index_failed");
  })();
  initialized.set(database as object, promise);
  try { await promise; } catch (error) { initialized.delete(database as object); throw error; }
}
