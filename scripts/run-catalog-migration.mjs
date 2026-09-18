const token = process.env.SITEWAKE_MAINTENANCE_TOKEN?.trim();
if (!token) throw new Error("SITEWAKE_MAINTENANCE_TOKEN is required");

const endpoint = "http://127.0.0.1:3000/api/internal/migrate-releases";
let lastError;
for (let attempt = 1; attempt <= 20; attempt += 1) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "x-sitewake-maintenance-token": token },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`catalog_migration_http_${response.status}: ${body.slice(0, 300)}`);
    }
    const result = JSON.parse(body);
    if ((result.releases?.failed || 0) > 0
      || (result.capabilityCatalogs?.failed || 0) > 0) {
      throw new Error(`catalog_migration_incomplete: ${body.slice(0, 300)}`);
    }
    console.log(JSON.stringify({ migration: "capability-catalog", ...result }));
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 20) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}
throw lastError || new Error("catalog_migration_failed");
