import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { postgresSql } from "../db/postgres-adapter.ts";

test("container delivery contains the complete control and capability production topology", async () => {
  const [compose, compact, worker, capabilityV2Runner, example] = await Promise.all([
    readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
    readFile(new URL("../compose.compact.yaml", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile.worker", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile.capability-v2-runner", import.meta.url), "utf8"),
    readFile(new URL("../.env.container.example", import.meta.url), "utf8"),
  ]);
  for (const service of ["control-plane", "postgres", "minio", "capability-v2-runtime-launcher", "authoring-worker", "validation-worker", "execution-worker", "cloudflared"]) assert.match(compose, new RegExp(`\\n  ${service}:`));
  assert.match(compose, /CAPABILITY_V2_RUNTIME_LAUNCHER_URL: http:\/\/capability-v2-runtime-launcher:3320/);
  assert.match(compose, /CAPABILITY_V2_RUNNER_SECRET: \$\{CAPABILITY_V2_RUNNER_SECRET:\?set CAPABILITY_V2_RUNNER_SECRET\}/);
  assert.match(compose, /CAPABILITY_V2_DISPATCH_TOKEN: \$\{CAPABILITY_V2_DISPATCH_TOKEN:\?set CAPABILITY_V2_DISPATCH_TOKEN\}/);
  assert.match(compose, /SITEWAKE_PAGE_AGENT_RUNTIME_V2: \$\{SITEWAKE_PAGE_AGENT_RUNTIME_V2:-off\}/);
  assert.match(compose, /SITEWAKE_PAGE_AGENT_EVIDENCE_V2: \$\{SITEWAKE_PAGE_AGENT_EVIDENCE_V2:-off\}/);
  assert.match(compose, /SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX: \$\{SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX:-off\}/);
  assert.match(compose, /command: \["node", "scripts\/capability-v2-runtime-launcher\.mjs"\]/);
  assert.match(compose, /CAPABILITY_V2_RUNTIME_LAUNCHER_HOST: 0\.0\.0\.0/);
  assert.match(compose, /dockerfile: Dockerfile\.capability-v2-runner/);
  assert.match(compact, /capability-v2-runtime-launcher:[\s\S]*mem_limit/);
  assert.match(compose, /SITEWAKE_RUNNER_ID: \$\{SITEWAKE_EXECUTION_RUNNER_ID:-execution-primary\}/);
  assert.match(compose, /SITEWAKE_RUNNER_ROLE: interactive/);
  assert.match(compose, /VINEXT_TRUSTED_HOSTS: \$\{SITEWAKE_PUBLIC_HOSTNAME:-\}/);
  assert.match(compose, /target: 3000[\s\S]*published: "\$\{SITEWAKE_PORT:-3000\}"[\s\S]*host_ip: "\$\{SITEWAKE_BIND_ADDRESS:-0\.0\.0\.0\}"/);
  assert.match(compose, /SITEWAKE_BROWSER_PUBLIC_URL: \$\{SITEWAKE_PUBLIC_ORIGIN:-http:\/\/control-plane:3000\}/);
  assert.doesNotMatch(compose, /SITEWAKE_BROWSER_PUBLIC_URL: https:\/\//);
  assert.doesNotMatch(compose, /SITEWAKE_BROWSER_PUBLIC_URL: [^\n]*localhost/);
  assert.match(compose, /OPENAI_BASE_URL: \$\{OPENAI_BASE_URL:-\}/);
  assert.match(compose, /MODEL_API_KEY: \$\{MODEL_API_KEY:-\}/);
  assert.doesNotMatch(compose, /MODEL_API_KEY: \$\{OPENAI_API_KEY/);
  assert.match(compact, /SITEWAKE_RUNNER_CONCURRENCY|mem_limit/);
  const compactAuthor = compact.slice(compact.indexOf("  authoring-worker:"), compact.indexOf("  validation-worker:"));
  assert.match(compactAuthor, /SITEWAKE_RUNNER_ROLE: any/);
  assert.doesNotMatch(compactAuthor, /profiles:/);
  assert.match(compact, /validation-worker:[\s\S]*profiles: \["validation"\]/);
  assert.match(compact, /execution-worker:[\s\S]*profiles: \["execution"\]/);
  // Authoring has one production path: Codex CLI in the authoring worker. There
  // is no runtime backend selector that can silently fork the flow.
  assert.doesNotMatch(compose, /CODEX_HOME|codex-home|SITEWAKE_AUTHORING_BACKEND|CAPABILITY_CODING_AGENT/);
  assert.match(worker, /@openai\/codex/);
  assert.match(worker, /^FROM mcr\.microsoft\.com\/playwright:v1\.61\.1-noble$/m);
  assert.match(worker, /find "\$vendor_root"[\s\S]*! -name "\$keep"/);
  assert.match(worker, /vendor_root="\$\(npm root -g\)\/@openai\/codex\/vendor"/);
  assert.match(capabilityV2Runner, /npm ci --omit=dev/);
  assert.match(capabilityV2Runner, /^FROM mcr\.microsoft\.com\/playwright:v1\.61\.1-noble$/m);
  assert.doesNotMatch(capabilityV2Runner, /playwright install/);
  assert.doesNotMatch(capabilityV2Runner, /@openai\/codex/);
  assert.match(example, /SITEWAKE_BIND_ADDRESS=0\.0\.0\.0/);
  assert.match(example, /SITEWAKE_PUBLIC_ORIGIN=http:\/\/192\.168\.1\.20:3000/);
  assert.match(example, /CAPABILITY_V2_BROWSER_PUBLIC_URL=/);
  // The shipped example carries only the canonical, product-name-free model
  // variables. Historical aliases stay readable but must not be advertised.
  assert.match(example, /MODEL_BASE_URL=https:\/\/api\.openai\.com\/v1/);
  assert.match(example, /^MODEL_API_KEY=/m);
  assert.doesNotMatch(example, /^(?:OPENAI)_/m);
});

test("container smoke reads each successful response body exactly once", async () => {
  const [source, healthSource] = await Promise.all([
    readFile(new URL("../scripts/container-smoke.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(source, /assert\.equal\([^\n]+await (?:health|sdk)\.text/);
  assert.match(source, /api\/health\?deep=1/);
  assert.match(source, /services\.objectStorage/);
  assert.match(source, /services\.capabilityV2RunnerLauncher/);
  assert.match(source, /runners\.workKinds/);
  assert.match(healthSource, /instance\.desiredState === "active"/);
  assert.match(healthSource, /\["stale", "offline", "error"\]/);
  assert.match(source, /api\/site-agents\?fresh=1/);
  assert.match(source, /__container_smoke__\/model/);
  assert.match(source, /if \(!sdk\.ok\)/);
});

test("Capability Center V2 launcher is networked, bounded, and continuously dispatches Pending work", async () => {
  const [launcher, runtime, dispatchRoute] = await Promise.all([
    readFile(new URL("../scripts/capability-v2-runtime-launcher.mjs", import.meta.url), "utf8"),
    readFile(new URL("../runner/capability-v2/runtime-launcher.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/capability-v2/dispatch/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(launcher, /CAPABILITY_V2_RUNTIME_LAUNCHER_HOST/);
  assert.match(launcher, /CAPABILITY_V2_RUNTIME_CONCURRENCY/);
  assert.match(launcher, /api\/internal\/capability-v2\/dispatch/);
  assert.match(launcher, /CAPABILITY_V2_DISPATCH_TOKEN/);
  assert.match(launcher, /learning-dispatch[\s\S]+authorization: `Bearer \$\{dispatchToken\}`/);
  assert.match(runtime, /dispatchNext\(\)/);
  assert.match(runtime, /CAPABILITY_V2_DISPATCH_MAX_ATTEMPTS/);
  assert.match(runtime, /failTaskDispatch/);
  assert.match(dispatchRoute, /launcher\.dispatchNext\(\)/);
});

test("production Runner tokens use the Compose signing secret with legacy fallback", async () => {
  const source = await readFile(new URL("../lib/capability-center-v2/runner-auth.ts", import.meta.url), "utf8");
  assert.match(source, /CAPABILITY_V2_RUNNER_SECRET/);
  assert.match(source, /CAPABILITY_V2_RUNNER_TOKEN/);
  assert.ok(source.indexOf("CAPABILITY_V2_RUNNER_SECRET") < source.indexOf("CAPABILITY_V2_RUNNER_TOKEN"));
});

test("server deployment uses the shared immutable code-only release boundary", async () => {
  const [pipeline, webTrigger, compose] = await Promise.all([
    readFile(new URL("../.cnb.yml", import.meta.url), "utf8"),
    readFile(new URL("../.cnb/web_trigger.yml", import.meta.url), "utf8"),
    readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
  ]);
  assert.match(pipeline, /name: Release gate/);
  assert.match(pipeline, /image: node:22\.13\.0-bookworm/);
  assert.match(pipeline, /services:\s*\n\s+- docker/);
  assert.match(pipeline, /script: npm run verify:release/);
  assert.match(pipeline, /^main:/m);
  assert.match(pipeline, /^\s+push:/m);
  assert.match(pipeline, /^\s+pull_request:/m);
  assert.match(pipeline, /^\s+web_trigger_release:/m);
  assert.match(pipeline, /^\s+api_trigger_release:/m);
  assert.match(pipeline, /key: sitewake-production-deploy/);
  assert.match(pipeline, /cancel-in-progress: false/);
  assert.match(webTrigger, /event: web_trigger_release/);
  const cloudflaredStart = compose.indexOf("\n  cloudflared:");
  const cloudflaredEnd = compose.indexOf("\nvolumes:", cloudflaredStart);
  assert.notEqual(cloudflaredStart, -1);
  assert.notEqual(cloudflaredEnd, -1);
  const cloudflared = compose.slice(cloudflaredStart, cloudflaredEnd);
  assert.match(cloudflared, /TUNNEL_TOKEN: \$\{CLOUDFLARE_TUNNEL_TOKEN:-\}/);
  assert.match(cloudflared, /command: tunnel --no-autoupdate run/);
  assert.doesNotMatch(cloudflared, /--token/);
  assert.match(pipeline, /timeout: 30m/);
  assert.match(pipeline, /101\.32\.190\.58/);
  assert.ok(
    pipeline.indexOf("npm run verify:release") < pipeline.indexOf("name: Deploy immutable code release"),
    "release verification must finish before credentials or server state are touched",
  );
  assert.match(pipeline, /scripts\/deploy-container-server\.mjs/);
  assert.match(pipeline, /SITEWAKE_SERVER_USER: sitewake-deploy/);
  assert.match(pipeline, /SITEWAKE_BUILD_SHA: \$CNB_COMMIT/);
  assert.doesNotMatch(pipeline, /rsync|\.env|POSTGRES_PASSWORD|OPENAI_API_KEY/);
  if (false) { // Legacy mutable-deployment assertions retired.
  assert.ok(
    deployment.indexOf('cp -p "$DEPLOY_PATH/$file" "$ROLLBACK_DIR/$file"')
      < deployment.indexOf("rsync -az --delete"),
    "the previous Compose definition must be snapshotted before source replacement",
  );
  assert.match(deployment, /pg_dump[\s\S]*-Fc/);
  assert.match(deployment, /test -s[\s\S]*pg_restore --list/);
  assert.match(deployment, /backup_retention_count=12/);
  assert.match(deployment, /pre-auto-deploy-\*\.dump[\s\S]*pre-four-table-\*\.dump/);
  assert.match(deployment, /Refusing to prune unexpected backup path/);
  assert.ok(
    deployment.indexOf('pg_restore --list < "$backup_file"')
      < deployment.indexOf("backup_retention_count=12"),
    "backup retention must run only after the newest backup has been verified",
  );
  assert.match(deployment, /rollback_release\(\)/);
  assert.match(deployment, /trap rollback_release EXIT/);
  assert.match(deployment, /trap 'exit 130' INT/);
  assert.match(deployment, /trap 'exit 143' TERM/);
  assert.match(deployment, /trap 'exit 129' HUP/);
  assert.match(deployment, /original_status=\$\?/);
  assert.match(deployment, /exit "\$original_status"/);
  assert.match(deployment, /previous_image_ids/);
  assert.match(deployment, /previous_image_refs/);
  assert.match(deployment, /sudo docker image inspect "\$image_id"/);
  assert.match(deployment, /sudo docker image tag "\$image_id" "\$backup_ref"/);
  assert.match(deployment, /Cannot protect \$service for rollback: running container \$container_id references missing image \$image_id/);
  assert.match(deployment, /container commits are deliberately forbidden/);
  assert.doesNotMatch(deployment, /docker commit/);
  assert.match(deployment, /sudo docker image tag[\s\S]+"\$\{previous_image_ids\[\$service\]\}"[\s\S]+"\$\{previous_image_refs\[\$service\]\}"/);
  assert.match(deployment, /rollback_compose\(\)/);
  assert.match(deployment, /compose "\$\{transaction_profiles\[@\]\}" rm --stop --force/);
  assert.match(deployment, /rollback_compose "\$\{transaction_profiles\[@\]\}" up -d --no-build[\s\S]+--force-recreate --no-deps/);
  assert.doesNotMatch(deployment, /compose[^\n]* start /);
  assert.match(deployment, /reference=sitewake-release-rollback\/\*:\*/);
  assert.match(deployment, /Refusing to remove unexpected rollback image/);
  assert.match(deployment, /sudo docker image prune --all --force/);
  assert.match(deployment, /sudo docker builder prune --force --filter until=24h/);
  assert.match(deployment, /minimum_build_kib=\$\(\(6 \* 1024 \* 1024\)\)/);
  assert.match(deployment, /for service in control-plane capability-v2-runtime-launcher "\$\{workers\[@\]\}"; do[\s\S]*compose build "\$service"/);
  assert.match(deployment, /run-capability-center-migration\.mjs --schema-only/);
  assert.match(deployment, /scripts\/migrate-d1-postgres\.mjs/);
  assert.match(deployment, /run-catalog-migration\.mjs/);
  for (const command of [
    "run-capability-center-migration.mjs --schema-only",
    "migrate-d1-postgres.mjs",
    "run-capability-center-migration.mjs",
    "run-catalog-migration.mjs",
  ]) {
    assert.match(
      deployment,
      new RegExp(`${command.replaceAll(".", "\\.")} <\\/dev\\/null`),
      `${command} must not consume the SSH heredoc that contains the remaining deployment steps`,
    );
  }
  assert.match(deployment, /partially configured; refusing to resume edge\/workers/);
  assert.match(deployment, /additive and backward/);
  assert.match(deployment, /breaking[\s\S]+manual activation/);
  const imageSnapshot = deployment.indexOf('sudo docker image tag "$image_id" "$backup_ref"');
  const failSafe = deployment.indexOf("trap rollback_release EXIT");
  const imageBuild = deployment.indexOf('for service in control-plane capability-v2-runtime-launcher "${workers[@]}"');
  const maintenanceStop = deployment.lastIndexOf('compose "${transaction_profiles[@]}" stop');
  const controlPlaneStart = deployment.indexOf("compose up -d --no-build postgres minio minio-init capability-v2-runtime-launcher control-plane");
  const schemaOnly = deployment.indexOf("run-capability-center-migration.mjs --schema-only");
  const d1Import = deployment.indexOf("scripts/migrate-d1-postgres.mjs");
  const fourTable = deployment.lastIndexOf("run-capability-center-migration.mjs");
  const catalog = deployment.indexOf("run-catalog-migration.mjs");
  const resume = deployment.indexOf('compose "${profiles[@]}" up -d --no-build --force-recreate');
  const loopbackHealth = deployment.indexOf("verify_release_health loopback");
  const publicHealth = deployment.indexOf("verify_release_health public");
  const complete = deployment.indexOf("deployment_complete=1");
  const disarm = deployment.indexOf("trap - EXIT INT TERM HUP");
  assert.ok(
    imageSnapshot < failSafe && failSafe < imageBuild
      && imageBuild < maintenanceStop && maintenanceStop < controlPlaneStart,
    "old images and the rollback trap must exist before the guarded maintenance window",
  );
  assert.ok(schemaOnly < d1Import && d1Import < fourTable && fourTable < catalog && catalog < resume);
  assert.ok(
    resume < loopbackHealth && loopbackHealth < publicHealth
      && publicHealth < complete && complete < disarm,
    "both exact-SHA health checks must pass before the transaction is committed",
  );
  assert.match(deployment, /"runtime":"container"/);
  assert.match(deployment, /"status":"ready"/);
  assert.match(deployment, /curl --fail --silent --show-error --max-time 8/);
  assert.match(deployment, /buildSha/);
  assert.doesNotMatch(`${build}\n${deployment}`, /deploy:cloudflare|deploy:prepare|sync-cloudflare-secrets|deploy:secrets/);
  }
});

test("container tunnel uses its dedicated lab hostname instead of deriving one from the Worker host", async () => {
  const source = await readFile(new URL("../scripts/provision-container-tunnel.mjs", import.meta.url), "utf8");
  assert.match(source, /lab-sitewake\.\$\{zoneName\}/);
  assert.doesNotMatch(source, /`lab\.\$\{workerHost\}`/);
});

test("server deployment never generates runtime configuration or clears the application root", async () => {
  const source = await readFile(new URL("../scripts/deploy-container-server.mjs", import.meta.url), "utf8");
  assert.match(source, /\/opt\/sitewake-incoming\/\$\{releaseId\}/);
  assert.match(source, /configShaBefore[\s\S]+configShaAfter/);
  assert.doesNotMatch(source, /find .*rm -rf|writeFileSync|\.env\.server\.runtime|OPENAI_API_KEY|POSTGRES_PASSWORD/);
  if (false) { // Legacy environment-generation assertions retired.
  assert.match(source, /pre-four-table-/);
  assert.match(source, /pg_dump[\s\S]*-Fc/);
  assert.match(source, /test -s[\s\S]*pg_restore --list/);
  assert.match(source, /Recovery hint: keep edge\/workers stopped/);
  assert.match(source, /no running sitewake postgres container \(fresh host\)/);
  assert.match(source, /stop authoring-worker validation-worker execution-worker capability-v2-runtime-launcher cloudflared/);
  assert.match(source, /sequentialBuilds/);
  assert.match(source, /docker image prune --all --force/);
  assert.match(source, /docker builder prune --force --filter until=24h/);
  assert.match(source, /docker compose -f compose\.yaml -f compose\.compact\.yaml build \$\{service\}/);
  assert.match(source, /up -d --no-build postgres minio minio-init capability-v2-runtime-launcher control-plane/);
  assert.match(source, /CAPABILITY_V2_RUNNER_SECRET: capabilityV2RunnerSecret/);
  assert.match(source, /CAPABILITY_V2_DISPATCH_TOKEN: capabilityV2DispatchToken/);
  assert.match(source, /CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN: capabilityV2LauncherToken/);
  assert.match(source, /CAPABILITY_V2_BROWSER_PUBLIC_URL: process\.env\.CAPABILITY_V2_BROWSER_PUBLIC_URL/);
  assert.match(source, /sudo env SITEWAKE_MAINTENANCE_TOKEN=\$\{maintenanceToken\} docker compose/);
  assert.doesNotMatch(source, /up -d --build --wait/);
  const schemaOnly = source.indexOf("run-capability-center-migration.mjs --schema-only");
  const d1Import = source.indexOf("scripts/migrate-d1-postgres.mjs");
  const fourTable = source.indexOf("exec -T control-plane node scripts/run-capability-center-migration.mjs`");
  const catalog = source.indexOf("scripts/run-catalog-migration.mjs");
  const workers = source.indexOf("--no-build --force-recreate");
  assert.ok(schemaOnly > 0 && schemaOnly < d1Import);
  assert.ok(d1Import < fourTable && fourTable < catalog && catalog < workers);
  assert.match(source, /up -d --no-build --force-recreate \$\{workersToResume\.join\(" "\)\}/);
  assert.match(source, /configuredD1Coordinates === d1Coordinates\.length/);
  assert.match(source, /configuredD1Coordinates > 0/);
  assert.match(source, /partially configured; refusing to resume edge\/workers/);
  assert.match(source, /Skipping D1 migration/);
  assert.match(source, /purgeSdkEntrypoints/);
  assert.match(source, /configureSdkBrowserCache/);
  assert.match(source, /sitewake-sdk-always-revalidate/);
  assert.match(source, /purge_cache/);
  }
});

test("container delivery makes stable SDK entrypoints revalidatable", async () => {
  const [dockerfile, patch, nextConfig] = await Promise.all([
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../scripts/patch-vinext-sdk-cache.mjs", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
  ]);
  assert.match(dockerfile, /patch-vinext-sdk-cache\.mjs/);
  assert.match(patch, /\^sitewake\(\?:-adaptive\)\?/);
  assert.match(patch, /no-cache, must-revalidate/);
  assert.match(nextConfig, /sitewake\|sitewake-adaptive/);
  assert.match(nextConfig, /CDN-Cache-Control/);
});

test("container activation targets one public hostname through the tunnel and removes only its Worker route", async () => {
  const [activation, tunnel] = await Promise.all([
    readFile(new URL("../scripts/activate-container-runtime.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/provision-container-tunnel.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(activation, /workers\/routes/);
  assert.match(activation, /health\.runtime !== "container"/);
  assert.match(activation, /item\.pattern === `\$\{publicHostname\}\/\*`/);
  assert.match(tunnel, /\[publicHostname, hostname\]/);
});

test("PostgreSQL adapter preserves D1 repository semantics without rewriting domain stores", () => {
  assert.equal(postgresSql("SELECT * FROM jobs WHERE id=? AND status=?"), "SELECT * FROM jobs WHERE id=$1 AND status=$2");
  assert.match(postgresSql("INSERT OR IGNORE INTO jobs (id,status) VALUES (?,?)"), /INSERT INTO jobs .*ON CONFLICT DO NOTHING/);
  assert.match(postgresSql("INSERT OR REPLACE INTO site_agent_v2_meta (key,value,updated_at) VALUES (?,?,?)"), /ON CONFLICT \(key\) DO UPDATE/);
  assert.match(postgresSql("SELECT json_extract(job_json,'$.lease.expiresAt') AS leaseExpiresAt FROM jobs"), /job_json::jsonb #>> '\{lease,expiresAt\}'.*AS "leaseExpiresAt"/);
});

test("proposal coalescing keeps its camel-case alias in PostgreSQL and dispatch failures stay non-fatal", async () => {
  const [store, runner] = await Promise.all([
    readFile(new URL("../db/capability-center-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8"),
  ]);
  assert.match(store, /AS "hasTask"[\s\S]+ORDER BY "hasTask" DESC,p\.created_at,p\.id/);
  const translated = postgresSql(`SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.proposal_id=p.id) AS "hasTask" FROM proposals p ORDER BY "hasTask" DESC,p.id`);
  assert.match(translated, /AS "hasTask"/);
  assert.match(translated, /ORDER BY "hasTask" DESC/);
  assert.doesNotMatch(translated, /ORDER BY hasTask DESC/);

  const dispatch = runner.slice(
    runner.indexOf("async function dispatchControlPlaneWork"),
    runner.indexOf("async function consume"),
  );
  assert.match(dispatch, /\.catch\(\(error\) => console\.warn\(`runner_control_plane_dispatch_failed:/);
  assert.ok(dispatch.indexOf(".catch(") < dispatch.indexOf(".finally("));
  assert.match(runner, /void dispatchControlPlaneWork\(\);[\s\S]+const \{ lease \} = await api/);
});

test("D1 migration is idempotent and only carries durable facts into PostgreSQL", async () => {
  const source = await readFile(new URL("../scripts/migrate-d1-postgres.mjs", import.meta.url), "utf8");
  for (const table of ["site_agent_v2_agents", "site_agent_v2_observations", "site_agent_v2_episodes", "site_agent_v2_artifacts", "site_agent_v2_releases"]) assert.match(source, new RegExp(`"${table}"`));
  for (const runnerConfigTable of ["site_agent_v2_runner_pools", "site_agent_v2_runner_placement_bindings"]) assert.match(source, new RegExp(`"${runnerConfigTable}"`));
  for (const legacyCapabilityTable of ["site_agent_v2_capability_projects", "site_agent_v2_capability_revisions", "site_agent_v2_capability_signals", "site_agent_v2_learning_jobs"]) assert.match(source, new RegExp(`"${legacyCapabilityTable}"`));
  for (const capabilityTable of ["site_agent_v2_capabilities", "site_agent_v2_capability_versions", "site_agent_v2_capability_proposals", "site_agent_v2_capability_tasks"]) assert.match(source, new RegExp(`"${capabilityTable}"`));
  // Historical learning jobs are a required four-table backfill source. Other
  // ephemeral runtime queues still must not cross the D1 -> PostgreSQL cutover.
  for (const runtimeTable of ["site_agent_v2_sessions", "site_agent_v2_validation_jobs", "site_agent_v3_agent_runs"]) assert.doesNotMatch(source, new RegExp(`"${runtimeTable}"`));
  assert.match(source, /ON CONFLICT DO NOTHING/);
  assert.match(source, /if \(!targetColumns\.size\) throw new Error\(`d1_migration_target_table_missing:\$\{table\}`\)/);
  assert.match(source, /d1TableSnapshot\(table\)/);
  assert.match(source, /d1_migration_source_changed/);
  assert.match(source, /d1_migration_conflict_without_source_primary_key/);
  assert.match(source, /sourceCount: sourceBefore\.count, inserted, targetWins/);
});

test("AI Program Author uses autonomous navigation exploration and Codex business authoring with durable audit trails", async () => {
  const [runner, navigationAuthor, protocol, schema, store, consoleSource, compact] = await Promise.all([
    readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8"),
    readFile(new URL("../runner/navigation-ai-author.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/site-knowledge/protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/site-agent-schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/capability-center-v1.tsx", import.meta.url), "utf8"),
    readFile(new URL("../compose.compact.yaml", import.meta.url), "utf8"),
  ]);
  for (const marker of ["runCodexAuthoringSession", "new CodexAuthoringDriver", "codex_no_submit", "authored_codex_success"]) assert.ok(runner.includes(marker), marker);
  for (const marker of ["runNavigationAIAuthoringSession", "exploreNavigationWithAI", "navigation-ai"]) assert.ok(`${runner}\n${navigationAuthor}`.includes(marker), marker);
  assert.match(navigationAuthor, /不要询问用户/);
  assert.match(navigationAuthor, /navigation_target_origin_invalid/);
  assert.match(navigationAuthor, /querySelectorAll\("a\[href\]"\)/);
  assert.doesNotMatch(navigationAuthor, /querySelectorAll\("a,button/);
  assert.doesNotMatch(runner, /requestAuthoringPlan|requestGroundedAuthoringDraft|submit_authoring_plan/);
  for (const type of ["CapabilitySignal", "CapabilityRFC", "ContractChangeProposal", "CodexAuthoringEvent"]) assert.match(protocol, new RegExp(`type ${type}`));
  for (const table of ["capability_signals", "capability_rfcs", "contract_proposals", "codex_authoring_events"]) assert.match(schema, new RegExp(`site_agent_v2_${table}`));
  assert.match(store, /if \(shouldQueueSignal\) await queueCapabilitySignal\(database, episode\)/);
  assert.match(store, /if \(terminalSignal\) statements\.push\(capabilitySignalStatement\(database, terminalSignal\)\)/);
  assert.match(store, /designCandidateFromEvidence\(episode, candidate\)/);
  assert.doesNotMatch(store, /persistCapabilityRfc/);
  assert.match(store, /designCapabilityContract/);
  const authoringControl = store.slice(
    store.indexOf("async function designLearningJob"),
    store.indexOf("export async function registerValidationRunner"),
  );
  assert.doesNotMatch(authoringControl, /json_set\(/);
  assert.match(store, /site_agent_v2_codex_authoring_events/);
  assert.match(consoleSource, /CapabilityCenterScreen/);
  assert.match(consoleSource, /CapabilityCenterV2Screen/);
  assert.match(compact, /SITEWAKE_RUNNER_ROLE: any/);
  assert.match(runner, /\["any", "interactive", "background", "author", "validate"\]\.includes\(configuredRunnerRole\)/);
  assert.match(runner, /void dispatchControlPlaneWork\(\)/);
});

test("the capability coding stage is a deterministic, pluggable, Codex-driven harness", async () => {
  const [harness, gate, bundler, workspace, driver, deployment] = await Promise.all([
    readFile(new URL("../lib/site-knowledge/authoring-harness.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/site-knowledge/authoring-gate.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/site-knowledge/authoring-bundler.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/site-knowledge/authoring-workspace.ts", import.meta.url), "utf8"),
    readFile(new URL("../runner/codex-authoring-driver.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/deployment.md", import.meta.url), "utf8"),
  ]);
  // Deterministic spine: workspace + bundler + gate + pluggable driver + fake for tests.
  for (const marker of ["class AuthoringHarness", "runAuthoringSession", "class FakeDriver", "interface CodingAgentDriver"]) assert.ok(harness.includes(marker), marker);
  assert.doesNotMatch(harness, /resolveCodingAgentKind|gateway/);
  assert.match(gate, /evaluateSubmitGate/);
  assert.match(bundler, /bundleWorkspace/);
  assert.match(bundler, /bare import/); // RCE surface: no bare/npm imports in a capability module
  assert.match(workspace, /normalizeVfsPath/);
  // Codex CLI driver is real (child process + FS) and runner-scoped, keyed on OPENAI_API_KEY.
  assert.match(driver, /class CodexAuthoringDriver/);
  assert.match(driver, /from "node:child_process"/);
  assert.match(driver, /OPENAI_API_KEY/);
  assert.match(deployment, /Codex CLI/);
});

test("orchestration and example files declare only SITEWAKE_-prefixed product variables", async () => {
  const files = ["../compose.yaml", "../compose.compact.yaml", "../Dockerfile", "../Dockerfile.worker",
    "../Dockerfile.capability-v2-runner", "../.env.example", "../.env.container.example"];
  // Everything an installation may set: the product prefix, the brand-free model
  // names, and the third-party / infrastructure families the stack composes.
  const allowed = /^(SITEWAKE_|MODEL(_|$)|OPENAI_|CAPABILITY_V2_|POSTGRES_|MINIO_|S3_|DATABASE_URL$|NODE_|VINEXT_|ACCESS_ADMIN_KEY$|CLOUDFLARE_|TUNNEL_TOKEN$|CODEX_|PLAYWRIGHT_|PORT$|HOSTNAME$|PATH$|HOME$)/;
  for (const file of files) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    const names = new Set([
      ...[...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(([, name]) => name),
      ...[...text.matchAll(/^\s*([A-Z][A-Z0-9_]*)[:=]/gm)].map(([, name]) => name),
      ...[...text.matchAll(/^(?:ARG|ENV)\s+([A-Z][A-Z0-9_]*)/gm)].map(([, name]) => name),
    ]);
    const offenders = [...names].filter((name) => !allowed.test(name));
    assert.deepEqual(offenders, [], `${file} declares variables outside the SITEWAKE_ contract`);
  }
});
