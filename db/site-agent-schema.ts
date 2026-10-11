import type { D1DatabaseLike } from "./index";

const SITE_AGENT_V2_STORAGE_VERSION = "25-site-preview+24-answer-routes+23-capability-center-settings+22-capability-task-runner+21-capability-center-four-table+20-model-response-history+19-gap-ai-verdicts+18-content-search-knowledge-gaps";
const SITE_AGENT_V3_STORAGE_VERSION = "7-page-observation-write-guard+6-page-observation-tombstones+5-page-observation-evidence+4-agent-run+submission-effect-tracking";
export const SITE_AGENT_V3_PAGE_OBSERVATION_MAX_PER_RUN = 11;

export const SITE_AGENT_V2_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS site_agent_v2_meta (
    key text PRIMARY KEY NOT NULL,
    value text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_agents (
    id text PRIMARY KEY NOT NULL,
    profile_json text NOT NULL,
    capability_center_json text NOT NULL DEFAULT '{"autoApproval":{"enabled":false,"prompt":""}}',
    active_release_id text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_connections (
    site_agent_id text PRIMARY KEY NOT NULL,
    origin text NOT NULL,
    url text NOT NULL,
    title text NOT NULL,
    heading text NOT NULL,
    connected_at text NOT NULL,
    last_seen_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_releases (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    version integer NOT NULL,
    content_hash text NOT NULL,
    release_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_release_version_idx
    ON site_agent_v2_releases (site_agent_id, version)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_sessions (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    browser_session_id text NOT NULL,
    status text NOT NULL,
    session_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    expires_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_sessions_agent_idx
    ON site_agent_v2_sessions (site_agent_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_observations (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    session_id text,
    kind text NOT NULL,
    scene_id text,
    observation_json text NOT NULL,
    occurred_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_observations_agent_idx
    ON site_agent_v2_observations (site_agent_id, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_episodes (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    task_session_id text NOT NULL,
    mode text NOT NULL,
    normalized_goal text NOT NULL,
    outcome_status text NOT NULL,
    episode_json text NOT NULL,
    started_at text NOT NULL,
    ended_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_episodes_agent_idx
    ON site_agent_v2_episodes (site_agent_id, ended_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_candidates (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    normalized_goal text NOT NULL,
    status text NOT NULL,
    base_release_version integer NOT NULL,
    candidate_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_candidates_agent_idx
    ON site_agent_v2_candidates (site_agent_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_learning_jobs (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    task_session_id text NOT NULL,
    status text NOT NULL,
    result_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_learning_jobs_queue_idx
    ON site_agent_v2_learning_jobs (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_validation_jobs (
    id text PRIMARY KEY NOT NULL,
    learning_job_id text NOT NULL,
    site_agent_id text NOT NULL,
    candidate_id text NOT NULL,
    status text NOT NULL,
    lease_expires_at text,
    job_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_validation_jobs_queue_idx
    ON site_agent_v2_validation_jobs (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_validation_jobs_agent_idx
    ON site_agent_v2_validation_jobs (site_agent_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_browser_runs (
    id text PRIMARY KEY NOT NULL,
    learning_job_id text NOT NULL,
    validation_job_id text,
    site_agent_id text NOT NULL,
    candidate_id text NOT NULL,
    status text NOT NULL,
    run_json text NOT NULL,
    started_at text NOT NULL,
    ended_at text
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_browser_runs_agent_idx
    ON site_agent_v2_browser_runs (site_agent_id, started_at)`,
  // Onboarding crawl jobs (crawl-knowledge pipeline). Durable queue mirroring the
  // validation-job shape: status + lease_expires_at drive lease/stale-recovery;
  // job_json carries seeds/limits, result_json the produced SiteKnowledgeDocument.
  // NOTE: the runner lease + HTTP endpoints that consume this are the remaining
  // live-infra wiring (Group 5); this declares the data contract ahead of them.
  `CREATE TABLE IF NOT EXISTS site_agent_v2_crawl_jobs (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    status text NOT NULL,
    lease_expires_at text,
    attempts integer NOT NULL DEFAULT 0,
    job_json text NOT NULL,
    result_json text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_crawl_jobs_queue_idx
    ON site_agent_v2_crawl_jobs (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_crawl_jobs_agent_idx
    ON site_agent_v2_crawl_jobs (site_agent_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_preview_jobs (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    status text NOT NULL,
    lease_expires_at text,
    attempts integer NOT NULL DEFAULT 0,
    job_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_preview_jobs_queue_idx
    ON site_agent_v2_preview_jobs (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_preview_jobs_agent_idx
    ON site_agent_v2_preview_jobs (site_agent_id, created_at)`,
  // The independent Site Knowledge base (profile/scenes/links/tree as one JSON),
  // versioned per (site_agent_id, version). Single source of truth for knowledge;
  // crawl + usage both write here. The Release references it (Phase C); during
  // the dual-write phase it is written alongside the release, keyed by the same
  // version, and read paths still use the release's embedded copy.
  `CREATE TABLE IF NOT EXISTS site_agent_v2_knowledge (
    site_agent_id text NOT NULL,
    version integer NOT NULL,
    content_hash text NOT NULL,
    knowledge_json text NOT NULL,
    created_at text NOT NULL,
    PRIMARY KEY (site_agent_id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_knowledge_agent_idx
    ON site_agent_v2_knowledge (site_agent_id, version)`,
  // Page content chunks for content-search (build-knowledge-center-v1, phase 1).
  // Separate from the knowledge JSON, which stays structure-only. One row per chunk;
  // keyword scoring runs at QUERY TIME over a site's chunks (in-JS char+bigram
  // token-overlap, reusing the planner tokenizer) — deliberately NO native FTS
  // (FTS5/tsvector) so the DDL stays portable across D1 and the Postgres adapter.
  // Native index / vector retrieval are deferred (phase 2, evidence-gated).
  `CREATE TABLE IF NOT EXISTS site_agent_v2_content (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    scene_id text,
    url text NOT NULL,
    chunk_index integer NOT NULL,
    heading_path text,
    text text NOT NULL,
    content_hash text NOT NULL,
    updated_at text NOT NULL,
    source text
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_content_agent_idx
    ON site_agent_v2_content (site_agent_id, url, chunk_index)`,
  // Crawl observation records (the cross-time baseline): one row per URL, overwritten
  // on every crawl.
  //
  // **Not knowledge** but the crawl ledger, so it cannot live in the release / knowledge
  // JSON: both add a version with a full copy on every re-crawl — one site reached 10 MB
  // over 46 versions — and the release row is read on every agent load. In this table
  // the total is always "URLs × two observations".
  `CREATE TABLE IF NOT EXISTS site_agent_v2_page_observations (
    site_agent_id text NOT NULL,
    url text NOT NULL,
    observations_json text NOT NULL,
    updated_at text NOT NULL,
    PRIMARY KEY (site_agent_id, url)
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_page_observations_agent_idx
    ON site_agent_v2_page_observations (site_agent_id, updated_at)`,
  // NOTE: the answer-route / knowledge-gap tables (site_agent_v2_answer_routes,
  // site_agent_v2_knowledge_gaps, site_agent_v2_gap_verdicts) were removed by
  // simplify-knowledge-search. No code reads or writes them; new deployments never create
  // them. Existing deployments keep their rows untouched (no destructive migration) — drop
  // them manually if desired.
  `CREATE TABLE IF NOT EXISTS site_agent_v2_artifacts (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    learning_job_id text NOT NULL,
    run_id text NOT NULL,
    kind text NOT NULL,
    object_key text NOT NULL,
    artifact_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_artifacts_agent_idx
    ON site_agent_v2_artifacts (site_agent_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_dom_replay_chunks (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    session_id text NOT NULL,
    document_id text NOT NULL,
    episode_id text,
    run_id text,
    seq_start integer NOT NULL,
    seq_end integer NOT NULL,
    chunk_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_dom_replay_chunks_episode_idx
    ON site_agent_v2_dom_replay_chunks (site_agent_id, episode_id, seq_start)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_dom_replay_chunks_run_idx
    ON site_agent_v2_dom_replay_chunks (site_agent_id, run_id, seq_start)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_dom_replay_chunks_expiry_idx
    ON site_agent_v2_dom_replay_chunks (created_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_artifact_chunks (
    artifact_id text NOT NULL,
    sequence integer NOT NULL,
    body blob NOT NULL,
    PRIMARY KEY (artifact_id, sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_runners (
    id text PRIMARY KEY NOT NULL,
    status text NOT NULL,
    runner_json text NOT NULL,
    last_heartbeat_at text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_runner_pools (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    pool_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `INSERT OR IGNORE INTO site_agent_v2_runner_pools
    (id,name,status,pool_json,created_at,updated_at)
    VALUES ('default','Default shared runners','active','{"id":"default","name":"Default shared runners","status":"active"}',datetime('now'),datetime('now'))`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_runner_instances (
    id text PRIMARY KEY NOT NULL,
    pool_id text NOT NULL,
    session_id text NOT NULL,
    generation integer NOT NULL,
    desired_state text NOT NULL,
    work_kinds_json text NOT NULL,
    max_concurrency integer NOT NULL,
    session_token_hash text NOT NULL,
    instance_json text NOT NULL,
    last_heartbeat_at text NOT NULL,
    heartbeat_expires_at text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_runner_instances_freshness_idx
    ON site_agent_v2_runner_instances (pool_id, desired_state, heartbeat_expires_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_runner_placement_bindings (
    id text PRIMARY KEY NOT NULL,
    pool_id text NOT NULL,
    site_agent_id text NOT NULL,
    work_kind text NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    binding_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_runner_placement_binding_target_idx
    ON site_agent_v2_runner_placement_bindings (site_agent_id, work_kind, target_kind, target_id)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_runner_placement_binding_site_idx
    ON site_agent_v2_runner_placement_bindings (pool_id, site_agent_id, work_kind, target_kind, target_id)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_runner_leases (
    id text PRIMARY KEY NOT NULL,
    pool_id text NOT NULL,
    active_work_key text,
    active_slot_key text,
    workload_kind text NOT NULL,
    workload_id text NOT NULL,
    site_agent_id text NOT NULL,
    work_kind text NOT NULL,
    runner_id text NOT NULL,
    runner_session_id text NOT NULL,
    status text NOT NULL,
    fence integer NOT NULL,
    slot integer NOT NULL,
    token_hash text NOT NULL,
    lease_json text NOT NULL,
    leased_at text NOT NULL,
    renewed_at text NOT NULL,
    expires_at text NOT NULL,
    completed_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_runner_lease_active_work_idx
    ON site_agent_v2_runner_leases (active_work_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_runner_lease_active_slot_idx
    ON site_agent_v2_runner_leases (active_slot_key)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_runner_lease_runner_idx
    ON site_agent_v2_runner_leases (runner_id, status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_runner_lease_workload_idx
    ON site_agent_v2_runner_leases (workload_kind, workload_id, fence)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_program_modules (
    content_hash text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    source text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_program_modules_agent_idx
    ON site_agent_v2_program_modules (site_agent_id, created_at)`,
  // Capability Center v2 owns exactly four business tables. Legacy project,
  // revision and job tables remain read-only during the staged migration.
  `CREATE TABLE IF NOT EXISTS site_agent_v2_capabilities (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    stable_key text NOT NULL,
    intent_key text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    goal_template text NOT NULL,
    status text NOT NULL,
    current_version_id text,
    latest_version_id text,
    contract_json text NOT NULL,
    capability_json text NOT NULL,
    unpublished_at text,
    deleted_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_capabilities_live_identity_idx
    ON site_agent_v2_capabilities (site_agent_id, stable_key)
    WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capabilities_status_idx
    ON site_agent_v2_capabilities (site_agent_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_capability_versions (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    capability_id text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL,
    implementation_json text NOT NULL,
    validation_json text NOT NULL,
    version_json text NOT NULL,
    published_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_capability_versions_number_idx
    ON site_agent_v2_capability_versions (capability_id, version)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_versions_agent_idx
    ON site_agent_v2_capability_versions (site_agent_id, capability_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_capability_proposals (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    capability_id text,
    duplicate_capability_id text,
    kind text NOT NULL,
    status text NOT NULL,
    proposal_json text NOT NULL,
    analysis_json text NOT NULL,
    archived_at text,
    deleted_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_proposals_queue_idx
    ON site_agent_v2_capability_proposals (site_agent_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_capability_tasks (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    proposal_id text,
    capability_id text,
    capability_version_id text,
    type text NOT NULL,
    status text NOT NULL,
    stage text NOT NULL,
    task_json text NOT NULL,
    result_json text NOT NULL,
    evidence_json text NOT NULL,
    error_json text,
    runner_id text,
    runner_session_id text,
    runner_lease_id text,
    runner_lease_fence integer,
    runner_lease_expires_at text,
    archived_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_tasks_queue_idx
    ON site_agent_v2_capability_tasks (site_agent_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_tasks_capability_idx
    ON site_agent_v2_capability_tasks (site_agent_id, capability_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_capability_projects (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    intent_key text NOT NULL,
    stable_key text,
    contract_fingerprint text,
    active_revision_id text,
    latest_revision_id text,
    status text NOT NULL,
    project_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_projects_status_idx
    ON site_agent_v2_capability_projects (site_agent_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_capability_suppressions (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    intent_key text NOT NULL,
    status text NOT NULL,
    suppression_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_suppressions_agent_idx
    ON site_agent_v2_capability_suppressions (site_agent_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_capability_revisions (
    id text PRIMARY KEY NOT NULL,
    project_id text NOT NULL,
    site_agent_id text NOT NULL,
    revision_number integer NOT NULL,
    status text NOT NULL,
    revision_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_capability_revisions_number_idx
    ON site_agent_v2_capability_revisions (project_id, revision_number)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_revisions_agent_idx
    ON site_agent_v2_capability_revisions (site_agent_id, project_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_revision_reviews (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    project_id text NOT NULL,
    revision_id text NOT NULL,
    validation_run_id text NOT NULL,
    validated_content_hash text NOT NULL,
    status text NOT NULL,
    review_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_revision_reviews_project_idx
    ON site_agent_v2_revision_reviews (site_agent_id, project_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_revision_reviews_status_idx
    ON site_agent_v2_revision_reviews (revision_id, validation_run_id, validated_content_hash, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_revision_reviews_terminal_idx
    ON site_agent_v2_revision_reviews (revision_id, validation_run_id, validated_content_hash)
    WHERE status IN ('approved','rejected')`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_capability_events (
    id text PRIMARY KEY NOT NULL,
    project_id text NOT NULL,
    revision_id text,
    site_agent_id text NOT NULL,
    type text NOT NULL,
    status text NOT NULL,
    event_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_events_project_idx
    ON site_agent_v2_capability_events (project_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_model_invocations (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    learning_job_id text,
    stage text NOT NULL,
    status text NOT NULL,
    invocation_json text NOT NULL,
    started_at text NOT NULL,
    ended_at text
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_model_invocations_job_idx
    ON site_agent_v2_model_invocations (site_agent_id, learning_job_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_authoring_guidance (
    id text PRIMARY KEY NOT NULL,
    project_id text NOT NULL,
    revision_id text NOT NULL,
    site_agent_id text NOT NULL,
    guidance_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_authoring_guidance_project_idx
    ON site_agent_v2_authoring_guidance (project_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_task_launches (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    project_id text,
    capability_id text,
    status text NOT NULL,
    token_hash text NOT NULL,
    claim_key_hash text,
    launch_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    expires_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_task_launches_agent_idx
    ON site_agent_v2_task_launches (site_agent_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_task_launches_expiry_idx
    ON site_agent_v2_task_launches (status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_navigation_build_heads (
    site_agent_id text NOT NULL,
    intent_key text NOT NULL,
    launch_id text NOT NULL,
    updated_at text NOT NULL,
    PRIMARY KEY (site_agent_id, intent_key)
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_navigation_build_heads_agent_idx
    ON site_agent_v2_navigation_build_heads (site_agent_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_capability_runs (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    project_id text,
    capability_id text NOT NULL,
    status text NOT NULL,
    environment_kind text NOT NULL,
    lease_expires_at text,
    idempotency_key_hash text,
    request_hash text,
    response_json text,
    run_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_runs_queue_idx
    ON site_agent_v2_capability_runs (status, environment_kind, created_at)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_runs_agent_idx
    ON site_agent_v2_capability_runs (site_agent_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_runs_history_idx
    ON site_agent_v2_capability_runs (site_agent_id, capability_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_capability_signals (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    intent_bucket text NOT NULL,
    status text NOT NULL,
    signal_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_signals_queue_idx
    ON site_agent_v2_capability_signals (status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_signals_intent_idx
    ON site_agent_v2_capability_signals (site_agent_id, intent_bucket, status)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_capability_rfcs (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    intent_key text NOT NULL,
    version integer NOT NULL,
    rfc_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_capability_rfcs_version_idx
    ON site_agent_v2_capability_rfcs (site_agent_id, intent_key, version)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_codex_authoring_events (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    learning_job_id text NOT NULL,
    sequence integer NOT NULL,
    event_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_codex_authoring_events_sequence_idx
    ON site_agent_v2_codex_authoring_events (learning_job_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_contract_proposals (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    rfc_id text NOT NULL,
    status text NOT NULL,
    proposal_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_contract_proposals_rfc_idx
    ON site_agent_v2_contract_proposals (rfc_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_capability_spec_docs (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    project_id text NOT NULL,
    revision_id text,
    version integer NOT NULL,
    spec_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_spec_docs_project_idx
    ON site_agent_v2_capability_spec_docs (site_agent_id, project_id, version)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_authoring_workspaces (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    project_id text NOT NULL,
    revision_id text,
    learning_job_id text,
    run_id text,
    hash text NOT NULL,
    workspace_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_authoring_workspaces_project_idx
    ON site_agent_v2_authoring_workspaces (site_agent_id, project_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v2_authoring_workspaces_run_idx
    ON site_agent_v2_authoring_workspaces (site_agent_id, run_id)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v2_model_response_history (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    conversation_json text NOT NULL,
    expires_at text NOT NULL,
    created_at text NOT NULL
  )`,
  // Historical Candidate/Job tables are evidence. New control-plane
  // projections never mutate or delete them during a schema upgrade.
  `INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at)
    VALUES ('storage_version','${SITE_AGENT_V2_STORAGE_VERSION}',datetime('now'))`,
] as const;

const initializationByDatabase = new WeakMap<object, Promise<void>>();

async function initialize(database: D1DatabaseLike) {
  const results = await database.batch(
    SITE_AGENT_V2_SCHEMA_STATEMENTS.map((statement) => database.prepare(statement)),
  );
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "site_agent_v2_schema_failed");
}

async function ensureCanonicalCapabilityColumns(database: D1DatabaseLike) {
  const columns = ["stable_key", "contract_fingerprint", "active_revision_id", "latest_revision_id"] as const;
  const statements = [];
  if (database.dialect === "postgres") {
    for (const column of columns) {
      statements.push(database.prepare(`ALTER TABLE site_agent_v2_capability_projects ADD COLUMN IF NOT EXISTS ${column} text`));
    }
  } else {
    const info = await database.prepare(`PRAGMA table_info(site_agent_v2_capability_projects)`).all<{ name: string }>();
    if (!info.success) throw new Error(info.error || "capability_project_schema_probe_failed");
    const existing = new Set((info.results || []).map((row) => row.name));
    for (const column of columns) {
      if (!existing.has(column)) statements.push(database.prepare(`ALTER TABLE site_agent_v2_capability_projects ADD COLUMN ${column} text`));
    }
  }
  statements.push(
    database.prepare(`DROP INDEX IF EXISTS site_agent_v2_capability_projects_intent_idx`),
    database.prepare(`CREATE INDEX IF NOT EXISTS site_agent_v2_capability_projects_intent_lookup_idx
      ON site_agent_v2_capability_projects (site_agent_id, intent_key)`),
    database.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_capability_projects_contract_idx
      ON site_agent_v2_capability_projects (site_agent_id, stable_key, contract_fingerprint)
      WHERE status<>'duplicate'`),
  );
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "canonical_capability_schema_failed");
}

/**
 * Source mark of a content block (`verbatim` / `model`). NULL reads as `verbatim` — old
 * rows were all indexed verbatim, so the default is correct and needs no backfill.
 */
async function ensureContentSourceSchema(database: D1DatabaseLike) {
  const statements = [];
  if (database.dialect === "postgres") {
    statements.push(database.prepare(`ALTER TABLE site_agent_v2_content ADD COLUMN IF NOT EXISTS source text`));
  } else {
    const info = await database.prepare(`PRAGMA table_info(site_agent_v2_content)`).all<{ name: string }>();
    if (!info.success) throw new Error(info.error || "site_content_schema_probe_failed");
    if (!(info.results || []).some((row) => row.name === "source")) {
      statements.push(database.prepare(`ALTER TABLE site_agent_v2_content ADD COLUMN source text`));
    }
  }
  if (!statements.length) return;
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "site_content_source_schema_failed");
}

/**
 * The crawl observation table. Created here rather than only listed in the DDL: the DDL
 * only reruns as a whole when the storage version changes, so an existing deployment
 * would not create a table merely added to the list.
 */
async function ensurePageObservationsSchema(database: D1DatabaseLike) {
  const results = await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS site_agent_v2_page_observations (
      site_agent_id text NOT NULL,
      url text NOT NULL,
      observations_json text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (site_agent_id, url)
    )`),
    database.prepare(`CREATE INDEX IF NOT EXISTS site_agent_v2_page_observations_agent_idx
      ON site_agent_v2_page_observations (site_agent_id, updated_at)`),
  ]);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "page_observations_schema_failed");
}

async function ensureModelResponseHistorySchema(database: D1DatabaseLike) {
  const statements = [];
  if (database.dialect === "postgres") {
    statements.push(database.prepare(
      `ALTER TABLE site_agent_v2_model_response_history ADD COLUMN IF NOT EXISTS expires_at text`,
    ));
  } else {
    const info = await database.prepare(`PRAGMA table_info(site_agent_v2_model_response_history)`).all<{ name: string }>();
    if (!info.success) throw new Error(info.error || "model_response_history_schema_probe_failed");
    if (!(info.results || []).some((row) => row.name === "expires_at")) {
      statements.push(database.prepare(`ALTER TABLE site_agent_v2_model_response_history ADD COLUMN expires_at text`));
    }
  }
  statements.push(database.prepare(
    `CREATE INDEX IF NOT EXISTS site_agent_v2_model_response_history_expiry_idx
      ON site_agent_v2_model_response_history (expires_at)`,
  ));
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "model_response_history_schema_failed");
}

async function ensureCapabilityRunIdempotencySchema(database: D1DatabaseLike) {
  const columns = ["idempotency_key_hash", "request_hash", "response_json"];
  const statements = [];
  if (database.dialect === "postgres") {
    for (const column of columns) {
      statements.push(database.prepare(
        `ALTER TABLE site_agent_v2_capability_runs ADD COLUMN IF NOT EXISTS ${column} text`,
      ));
    }
  } else {
    const info = await database.prepare(
      `PRAGMA table_info(site_agent_v2_capability_runs)`,
    ).all<{ name: string }>();
    if (!info.success) throw new Error(info.error || "capability_run_schema_probe_failed");
    const existing = new Set((info.results || []).map((row) => row.name));
    for (const column of columns) {
      if (!existing.has(column)) {
        statements.push(database.prepare(
          `ALTER TABLE site_agent_v2_capability_runs ADD COLUMN ${column} text`,
        ));
      }
    }
  }
  statements.push(database.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v2_capability_runs_idempotency_idx
       ON site_agent_v2_capability_runs (site_agent_id, idempotency_key_hash)`,
  ));
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "capability_run_idempotency_schema_failed");
}

async function ensureCapabilityTaskRunnerSchema(database: D1DatabaseLike) {
  const columns = [
    ["runner_id", "text"],
    ["runner_session_id", "text"],
    ["runner_lease_id", "text"],
    ["runner_lease_fence", "integer"],
    ["runner_lease_expires_at", "text"],
  ] as const;
  const statements = [];
  if (database.dialect === "postgres") {
    for (const [column, type] of columns) {
      statements.push(database.prepare(
        `ALTER TABLE site_agent_v2_capability_tasks ADD COLUMN IF NOT EXISTS ${column} ${type}`,
      ));
    }
  } else {
    const info = await database.prepare(
      `PRAGMA table_info(site_agent_v2_capability_tasks)`,
    ).all<{ name: string }>();
    if (!info.success) throw new Error(info.error || "capability_task_runner_schema_probe_failed");
    const existing = new Set((info.results || []).map((row) => row.name));
    for (const [column, type] of columns) {
      if (!existing.has(column)) {
        statements.push(database.prepare(
          `ALTER TABLE site_agent_v2_capability_tasks ADD COLUMN ${column} ${type}`,
        ));
      }
    }
  }
  statements.push(database.prepare(
    `CREATE INDEX IF NOT EXISTS site_agent_v2_capability_tasks_runner_queue_idx
       ON site_agent_v2_capability_tasks (status, stage, runner_lease_expires_at, created_at)`,
  ));
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "capability_task_runner_schema_failed");
}

async function ensureCapabilityProposalLifecycleSchema(database: D1DatabaseLike) {
  const columns = ["archived_at", "deleted_at"] as const;
  const statements = [];
  if (database.dialect === "postgres") {
    for (const column of columns) {
      statements.push(database.prepare(
        `ALTER TABLE site_agent_v2_capability_proposals ADD COLUMN IF NOT EXISTS ${column} text`,
      ));
    }
  } else {
    const info = await database.prepare(
      `PRAGMA table_info(site_agent_v2_capability_proposals)`,
    ).all<{ name: string }>();
    if (!info.success) throw new Error(info.error || "capability_proposal_schema_probe_failed");
    const existing = new Set((info.results || []).map((row) => row.name));
    for (const column of columns) {
      if (!existing.has(column)) {
        statements.push(database.prepare(
          `ALTER TABLE site_agent_v2_capability_proposals ADD COLUMN ${column} text`,
        ));
      }
    }
  }
  if (!statements.length) return;
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "capability_proposal_schema_failed");
}

async function ensureCapabilityCenterSettingsSchema(database: D1DatabaseLike) {
  const column = "capability_center_json";
  const definition = `text NOT NULL DEFAULT '{"autoApproval":{"enabled":false,"prompt":""}}'`;
  const statements = [];
  if (database.dialect === "postgres") {
    statements.push(database.prepare(`ALTER TABLE site_agent_v2_agents ADD COLUMN IF NOT EXISTS ${column} ${definition}`));
  } else {
    const info = await database.prepare(`PRAGMA table_info(site_agent_v2_agents)`).all<{ name: string }>();
    if (!info.success) throw new Error(info.error || "capability_center_settings_schema_probe_failed");
    if (!(info.results || []).some((row) => row.name === column)) {
      statements.push(database.prepare(`ALTER TABLE site_agent_v2_agents ADD COLUMN ${column} ${definition}`));
    }
  }
  if (!statements.length) return;
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "capability_center_settings_schema_failed");
}

/**
 * Widget presentation config lives on the agent row, not inside the versioned
 * Release snapshot. A Release is immutable and its id derives from `version`,
 * so storing `agentConfig` there forced a recoloured widget to mint a new
 * knowledge version — which then broke execution pinning for queued tasks.
 * Both columns are nullable: reads fall back to the value still embedded in
 * `release_json` until the backfill has run.
 */
async function ensureAgentConfigColumns(database: D1DatabaseLike) {
  const columns: Array<[string, string]> = [
    ["agent_config_json", "text"],
    ["agent_config_updated_at", "text"],
  ];
  const statements = [];
  if (database.dialect === "postgres") {
    for (const [column, definition] of columns) {
      statements.push(database.prepare(`ALTER TABLE site_agent_v2_agents ADD COLUMN IF NOT EXISTS ${column} ${definition}`));
    }
  } else {
    const info = await database.prepare(`PRAGMA table_info(site_agent_v2_agents)`).all<{ name: string }>();
    if (!info.success) throw new Error(info.error || "agent_config_schema_probe_failed");
    const existing = new Set((info.results || []).map((row) => row.name));
    for (const [column, definition] of columns) {
      if (!existing.has(column)) statements.push(database.prepare(`ALTER TABLE site_agent_v2_agents ADD COLUMN ${column} ${definition}`));
    }
  }
  if (!statements.length) return;
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "agent_config_schema_failed");
}

export async function ensureSiteAgentV2Schema(database: D1DatabaseLike) {
  const cached = initializationByDatabase.get(database as object);
  if (cached) return cached;
  const promise = (async () => {
    let storageVersion: string | undefined;
    try {
      const probe = await database.prepare(`SELECT value FROM site_agent_v2_meta WHERE key='storage_version' LIMIT 1`).all<{ value: string }>();
      storageVersion = probe.success ? probe.results?.[0]?.value : undefined;
    } catch (error) {
      // Existing v2 databases predate the metadata table. D1 throws for a
      // missing table instead of returning `success: false`, so treat only
      // that specific probe failure as the signal to run the migration.
      if (!/no such table|does not exist/.test(String(error).toLowerCase())) throw error;
    }
    if (storageVersion !== SITE_AGENT_V2_STORAGE_VERSION) await initialize(database);
    await ensureCanonicalCapabilityColumns(database);
    await ensureModelResponseHistorySchema(database);
    await ensureContentSourceSchema(database);
    await ensurePageObservationsSchema(database);
    await ensureCapabilityRunIdempotencySchema(database);
    await ensureCapabilityTaskRunnerSchema(database);
    await ensureCapabilityProposalLifecycleSchema(database);
    await ensureCapabilityCenterSettingsSchema(database);
    await ensureAgentConfigColumns(database);
  })();
  initializationByDatabase.set(database as object, promise);
  try {
    await promise;
  } catch (error) {
    initializationByDatabase.delete(database as object);
    throw error;
  }
}

export const SITE_AGENT_V3_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS site_agent_v3_meta (
    key text PRIMARY KEY NOT NULL,
    value text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_agent_runs (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    origin text NOT NULL,
    status text NOT NULL,
    revision integer NOT NULL,
    page_epoch integer NOT NULL,
    event_sequence integer NOT NULL,
    resume_token_hash text NOT NULL,
    handoff_token_hash text,
    handoff_expires_at text,
    run_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    expires_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_agent_runs_agent_idx
    ON site_agent_v3_agent_runs (site_agent_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_agent_runs_expiry_idx
    ON site_agent_v3_agent_runs (status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_run_events (
    id text PRIMARY KEY NOT NULL,
    run_id text NOT NULL,
    sequence integer NOT NULL,
    type text NOT NULL,
    event_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v3_run_events_sequence_idx
    ON site_agent_v3_run_events (run_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_browser_ports (
    id text PRIMARY KEY NOT NULL,
    run_id text NOT NULL,
    page_epoch integer NOT NULL,
    state text NOT NULL,
    port_json text NOT NULL,
    claimed_at text NOT NULL,
    last_seen_at text NOT NULL,
    lease_expires_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_browser_ports_run_idx
    ON site_agent_v3_browser_ports (run_id, page_epoch)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_tool_calls (
    id text PRIMARY KEY NOT NULL,
    run_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    call_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_tool_calls_run_idx
    ON site_agent_v3_tool_calls (run_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_execution_receipts (
    id text PRIMARY KEY NOT NULL,
    run_id text NOT NULL,
    slice_id text NOT NULL,
    page_epoch integer NOT NULL,
    status text NOT NULL,
    receipt_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v3_execution_receipts_slice_idx
    ON site_agent_v3_execution_receipts (run_id, slice_id)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_page_observations (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    run_id text NOT NULL,
    episode_id text NOT NULL,
    browser_session_id text NOT NULL,
    document_id text NOT NULL,
    page_epoch integer NOT NULL,
    turn_index integer NOT NULL,
    kind text NOT NULL,
    sha256 text NOT NULL,
    observation_json text NOT NULL,
    captured_at text NOT NULL,
    expires_at text NOT NULL,
    purged_at text,
    cleanup_reason text,
    created_at text NOT NULL
  )`,
  `DROP INDEX IF EXISTS site_agent_v3_page_observations_turn_idx`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v3_page_observations_epoch_turn_idx
    ON site_agent_v3_page_observations (run_id, page_epoch, turn_index)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_page_observations_episode_idx
    ON site_agent_v3_page_observations (site_agent_id, episode_id, turn_index)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_page_observations_expiry_idx
    ON site_agent_v3_page_observations (expires_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_capability_experience_outbox (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    run_id text NOT NULL,
    episode_id text NOT NULL,
    authority_kind text NOT NULL,
    authority text,
    source_capability_id text,
    source_version_id text,
    observation_refs_json text NOT NULL,
    status text NOT NULL,
    attempts integer NOT NULL,
    next_attempt_at text,
    result_json text,
    last_error text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `DROP INDEX IF EXISTS site_agent_v3_capability_experience_outbox_episode_idx`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v3_capability_experience_outbox_authority_idx
    ON site_agent_v3_capability_experience_outbox (site_agent_id, episode_id, authority_kind)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_capability_experience_outbox_queue_idx
    ON site_agent_v3_capability_experience_outbox (status, next_attempt_at, updated_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_capability_programs (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    capability_id text NOT NULL,
    revision_id text NOT NULL,
    status text NOT NULL,
    program_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_capability_programs_agent_idx
    ON site_agent_v3_capability_programs (site_agent_id, capability_id)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_usage_facts (
    run_id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    actor_key text NOT NULL,
    source text NOT NULL,
    goal text NOT NULL,
    status text NOT NULL,
    outcome_status text NOT NULL,
    outcome_code text NOT NULL,
    mode text NOT NULL,
    capability_id text,
    capability_used integer NOT NULL,
    knowledge_used integer NOT NULL,
    knowledge_succeeded integer NOT NULL,
    adaptive integer NOT NULL,
    repair integer NOT NULL,
    human_handoff integer NOT NULL,
    failure_category text NOT NULL,
    duration_ms integer NOT NULL,
    page_count integer NOT NULL,
    release_id text,
    release_version integer,
    fact_json text NOT NULL,
    started_at text NOT NULL,
    ended_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_usage_facts_agent_time_idx
    ON site_agent_v3_usage_facts (site_agent_id, ended_at, run_id)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_usage_facts_capability_idx
    ON site_agent_v3_usage_facts (site_agent_id, capability_id, ended_at)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_usage_facts_outcome_idx
    ON site_agent_v3_usage_facts (site_agent_id, outcome_status, ended_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_effect_analyses (
    run_id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    actor_key text NOT NULL,
    status text NOT NULL,
    goal_status text,
    primary_issue text NOT NULL,
    has_improvement integer NOT NULL,
    analysis_json text NOT NULL,
    submitted_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_effect_analyses_agent_time_idx
    ON site_agent_v3_effect_analyses (site_agent_id, submitted_at, run_id)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_effect_analyses_status_idx
    ON site_agent_v3_effect_analyses (site_agent_id, status, submitted_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_effect_analysis_jobs (
    id text PRIMARY KEY NOT NULL,
    run_id text NOT NULL,
    site_agent_id text NOT NULL,
    status text NOT NULL,
    attempts integer NOT NULL,
    job_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS site_agent_v3_effect_analysis_jobs_run_idx
    ON site_agent_v3_effect_analysis_jobs (run_id)`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_effect_analysis_jobs_queue_idx
    ON site_agent_v3_effect_analysis_jobs (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_effect_improvements (
    id text PRIMARY KEY NOT NULL,
    run_id text NOT NULL,
    site_agent_id text NOT NULL,
    kind text NOT NULL,
    target_id text,
    status text NOT NULL,
    improvement_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_effect_improvements_agent_idx
    ON site_agent_v3_effect_improvements (site_agent_id, status, created_at)`,
  `CREATE TABLE IF NOT EXISTS site_agent_v3_engagement_events (
    id text PRIMARY KEY NOT NULL,
    site_agent_id text NOT NULL,
    actor_key text NOT NULL,
    browser_session_id text NOT NULL,
    run_id text,
    type text NOT NULL,
    event_json text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_agent_v3_engagement_events_agent_time_idx
    ON site_agent_v3_engagement_events (site_agent_id, created_at)`,
  `INSERT OR REPLACE INTO site_agent_v3_meta (key,value,updated_at)
    VALUES ('storage_version','${SITE_AGENT_V3_STORAGE_VERSION}',datetime('now'))`,
] as const;

const v3InitializationByDatabase = new WeakMap<object, Promise<void>>();

async function ensurePageObservationTombstoneColumns(database: D1DatabaseLike) {
  if (database.dialect === "postgres") {
    const results = await database.batch([
      database.prepare(`ALTER TABLE IF EXISTS site_agent_v3_page_observations ADD COLUMN IF NOT EXISTS purged_at text`),
      database.prepare(`ALTER TABLE IF EXISTS site_agent_v3_page_observations ADD COLUMN IF NOT EXISTS cleanup_reason text`),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure) throw new Error(failure.error || "site_agent_v3_schema_failed");
    return;
  }
  const columns = await database.prepare(`PRAGMA table_info(site_agent_v3_page_observations)`).all<{ name: string }>();
  if (!columns.success || !columns.results?.length) return;
  const names = new Set(columns.results.map((column) => column.name));
  const statements = [
    !names.has("purged_at") ? database.prepare(`ALTER TABLE site_agent_v3_page_observations ADD COLUMN purged_at text`) : undefined,
    !names.has("cleanup_reason") ? database.prepare(`ALTER TABLE site_agent_v3_page_observations ADD COLUMN cleanup_reason text`) : undefined,
  ].filter((statement): statement is NonNullable<typeof statement> => Boolean(statement));
  if (!statements.length) return;
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "site_agent_v3_schema_failed");
}

async function ensureCapabilityExperienceAuthorityKind(database: D1DatabaseLike) {
  const columns = database.dialect === "postgres"
    ? await database.prepare(`SELECT column_name AS name FROM information_schema.columns WHERE table_name='site_agent_v3_capability_experience_outbox'`).all<{ name: string }>()
    : await database.prepare(`PRAGMA table_info(site_agent_v3_capability_experience_outbox)`).all<{ name: string }>();
  if (!columns.success || !columns.results?.length) return;
  const names = new Set(columns.results.map((column) => column.name));
  const statements = [
    !names.has("authority_kind")
      ? database.prepare(`ALTER TABLE site_agent_v3_capability_experience_outbox ADD COLUMN authority_kind text`)
      : undefined,
    !names.has("authority_kind") && names.has("authority")
      ? database.prepare(`UPDATE site_agent_v3_capability_experience_outbox SET authority_kind=authority WHERE authority_kind IS NULL`)
      : undefined,
    !names.has("authority")
      ? database.prepare(`ALTER TABLE site_agent_v3_capability_experience_outbox ADD COLUMN authority text`)
      : undefined,
    !names.has("authority") && names.has("authority_kind")
      ? database.prepare(`UPDATE site_agent_v3_capability_experience_outbox SET authority=authority_kind WHERE authority IS NULL`)
      : undefined,
    !names.has("source_version_id")
      ? database.prepare(`ALTER TABLE site_agent_v3_capability_experience_outbox ADD COLUMN source_version_id text`)
      : undefined,
  ].filter((statement): statement is NonNullable<typeof statement> => Boolean(statement));
  if (!statements.length) return;
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "site_agent_v3_schema_failed");
}

async function ensurePageObservationWriteGuard(database: D1DatabaseLike) {
  const statements = database.dialect === "postgres"
    ? [
      database.prepare(`CREATE OR REPLACE FUNCTION site_agent_v3_page_observation_write_guard()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext(NEW.run_id));
          IF EXISTS (
            SELECT 1 FROM site_agent_v3_page_observations existing
            WHERE existing.id=NEW.id AND (
              existing.site_agent_id<>NEW.site_agent_id OR existing.run_id<>NEW.run_id
              OR existing.episode_id<>NEW.episode_id OR existing.browser_session_id<>NEW.browser_session_id
              OR existing.document_id<>NEW.document_id OR existing.page_epoch<>NEW.page_epoch
              OR existing.turn_index<>NEW.turn_index OR existing.kind<>NEW.kind OR existing.sha256<>NEW.sha256
            )
          ) THEN
            RAISE EXCEPTION 'page_observation_conflict';
          END IF;
          IF EXISTS (
            SELECT 1 FROM site_agent_v3_page_observations existing
            WHERE existing.run_id=NEW.run_id AND existing.page_epoch=NEW.page_epoch
              AND existing.turn_index=NEW.turn_index AND existing.id<>NEW.id
          ) THEN
            RAISE EXCEPTION 'page_observation_conflict';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM site_agent_v3_page_observations existing WHERE existing.id=NEW.id)
            AND (SELECT COUNT(*) FROM site_agent_v3_page_observations existing WHERE existing.run_id=NEW.run_id) >= ${SITE_AGENT_V3_PAGE_OBSERVATION_MAX_PER_RUN} THEN
            RAISE EXCEPTION 'page_observation_run_limit';
          END IF;
          RETURN NEW;
        END;
        $$`),
      database.prepare(`DROP TRIGGER IF EXISTS site_agent_v3_page_observation_write_guard
        ON site_agent_v3_page_observations`),
      database.prepare(`CREATE TRIGGER site_agent_v3_page_observation_write_guard
        BEFORE INSERT ON site_agent_v3_page_observations
        FOR EACH ROW EXECUTE FUNCTION site_agent_v3_page_observation_write_guard()`),
    ]
    : [database.prepare(`CREATE TRIGGER IF NOT EXISTS site_agent_v3_page_observation_write_guard
      BEFORE INSERT ON site_agent_v3_page_observations
      BEGIN
        SELECT RAISE(ABORT, 'page_observation_conflict')
        WHERE EXISTS (
          SELECT 1 FROM site_agent_v3_page_observations existing
          WHERE existing.id=NEW.id AND (
            existing.site_agent_id<>NEW.site_agent_id OR existing.run_id<>NEW.run_id
            OR existing.episode_id<>NEW.episode_id OR existing.browser_session_id<>NEW.browser_session_id
            OR existing.document_id<>NEW.document_id OR existing.page_epoch<>NEW.page_epoch
            OR existing.turn_index<>NEW.turn_index OR existing.kind<>NEW.kind OR existing.sha256<>NEW.sha256
          )
        );
        SELECT RAISE(ABORT, 'page_observation_conflict')
        WHERE EXISTS (
          SELECT 1 FROM site_agent_v3_page_observations existing
          WHERE existing.run_id=NEW.run_id AND existing.page_epoch=NEW.page_epoch
            AND existing.turn_index=NEW.turn_index AND existing.id<>NEW.id
        );
        SELECT RAISE(ABORT, 'page_observation_run_limit')
        WHERE NOT EXISTS (SELECT 1 FROM site_agent_v3_page_observations existing WHERE existing.id=NEW.id)
          AND (SELECT COUNT(*) FROM site_agent_v3_page_observations existing WHERE existing.run_id=NEW.run_id) >= ${SITE_AGENT_V3_PAGE_OBSERVATION_MAX_PER_RUN};
      END`)];
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) throw new Error(failure.error || "site_agent_v3_schema_failed");
}

export async function ensureSiteAgentV3Schema(database: D1DatabaseLike) {
  const cached = v3InitializationByDatabase.get(database as object);
  if (cached) return cached;
  const promise = (async () => {
    let storageVersion: string | undefined;
    try {
      const probe = await database.prepare(`SELECT value FROM site_agent_v3_meta WHERE key='storage_version' LIMIT 1`).all<{ value: string }>();
      storageVersion = probe.success ? probe.results?.[0]?.value : undefined;
    } catch (error) {
      if (!/no such table|does not exist/.test(String(error).toLowerCase())) throw error;
    }
    await ensurePageObservationTombstoneColumns(database);
    await ensureCapabilityExperienceAuthorityKind(database);
    if (storageVersion !== SITE_AGENT_V3_STORAGE_VERSION) {
      const results = await database.batch(SITE_AGENT_V3_SCHEMA_STATEMENTS.map((statement) => database.prepare(statement)));
      const failure = results.find((result) => !result.success);
      if (failure) throw new Error(failure.error || "site_agent_v3_schema_failed");
    }
    // The guard is deliberately installed outside the static statement list:
    // SQLite and PostgreSQL use different trigger languages. It serializes
    // same-run inserts and enforces conflicts/limits inside the write txn.
    await ensurePageObservationWriteGuard(database);
  })();
  v3InitializationByDatabase.set(database as object, promise);
  try { await promise; }
  catch (error) { v3InitializationByDatabase.delete(database as object); throw error; }
}
