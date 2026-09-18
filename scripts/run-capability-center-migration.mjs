const token = process.env.SITEWAKE_MAINTENANCE_TOKEN?.trim();
if (!token) throw new Error("SITEWAKE_MAINTENANCE_TOKEN is required");

const schemaOnly = process.argv.includes("--schema-only");
const endpoint = `http://127.0.0.1:3000/api/internal/migrate-capability-center${schemaOnly ? "?schema-only=1" : ""}`;
let lastError;
for (let attempt = 1; attempt <= 20; attempt += 1) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "x-sitewake-maintenance-token": token },
    });
  } catch (error) {
    lastError = error;
    if (attempt < 20) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    break;
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`capability_center_migration_http_${response.status}: ${body.slice(0, 500)}`);
  }
  const result = JSON.parse(body);
  if (schemaOnly) {
    if (result.schemaReady !== true) {
      throw new Error(`capability_center_schema_incomplete: ${body.slice(0, 500)}`);
    }
    console.log(JSON.stringify({ migration: "capability-center-schema", ...result }));
    process.exit(0);
  }
  const counts = result.verification?.counts;
  const legacySources = result.verification?.legacySources;
  if (result.verification?.passed !== true
    || result.verification?.marker?.actual !== "2"
    || !["capabilities", "versions", "proposals", "tasks"].every((key) => Number.isSafeInteger(counts?.[key]) && counts[key] >= 0)
    || !["projects", "revisions", "signals", "learningJobs"].every((key) => Number.isSafeInteger(legacySources?.[key]) && legacySources[key] >= 0)
    || result.verification?.catastrophicEmptyBackfill !== false
    || (result.verification?.orphanVersions || 0) !== 0
    || (result.verification?.orphanTasks || 0) !== 0
    || (result.verification?.orphanProposalCapabilityReferences || 0) !== 0
    || (result.verification?.orphanProposalDuplicateReferences || 0) !== 0
    || (result.verification?.orphanCurrentVersionPointers || 0) !== 0
    || (result.verification?.orphanLatestVersionPointers || 0) !== 0
    || (result.verification?.duplicateLiveStableKeys || 0) !== 0) {
    throw new Error(`capability_center_migration_incomplete: ${body.slice(0, 500)}`);
  }
  console.log(JSON.stringify({ migration: "capability-center-four-table", ...result }));
  process.exit(0);
}
throw lastError || new Error("capability_center_migration_failed");
