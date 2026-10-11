import {
  batchCanonicalizeCapabilityCatalogs,
  batchSlimReleases,
} from "@/db/site-agent-store";
import { internalMaintenanceAuthorized } from "../../site-agents/http";

/**
 * One-time (idempotent) maintenance: slim every stored release, moving its
 * embedded knowledge into the knowledge table. Safe to call repeatedly — rows
 * already slim are skipped. Run once after deploying the storage-dedup change.
 */
export async function POST(request: Request) {
  if (!(await internalMaintenanceAuthorized(request))) {
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  const releases = await batchSlimReleases();
  const capabilityCatalogs = await batchCanonicalizeCapabilityCatalogs();
  const failed = releases.failed + capabilityCatalogs.failed;
  return Response.json(
    {
      releases,
      capabilityCatalogs,
      ...(failed > 0 ? { error: "catalog_migration_incomplete", failed } : {}),
    },
    {
      status: failed > 0 ? 500 : 200,
      headers: { "cache-control": "no-store" },
    },
  );
}
