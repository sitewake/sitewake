import {
  backfillLegacyCapabilityCenter,
  verifyCapabilityCenterMigration,
} from "@/db/capability-center-store";
import { getD1Binding } from "@/db/index";
import { ensureSiteAgentV2Schema } from "@/db/site-agent-schema";
import { ensureCapabilityCenterV2Schema } from "@/db/capability-center-v2-schema";
import { internalMaintenanceAuthorized } from "../../site-agents/http";

const NO_STORE = { "cache-control": "no-store" };

/** Explicit, idempotent production cutover for the four-table Capability Center. */
export async function POST(request: Request) {
  if (!(await internalMaintenanceAuthorized(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const database = getD1Binding();
  if (!database) {
    return Response.json(
      { error: "capability_center_database_unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
  try {
    if (new URL(request.url).searchParams.get("schema-only") === "1") {
      await Promise.all([
        ensureSiteAgentV2Schema(database),
        ensureCapabilityCenterV2Schema(database),
      ]);
      return Response.json({ schemaReady: true }, { headers: NO_STORE });
    }
    const migration = await backfillLegacyCapabilityCenter(database);
    const verification = await verifyCapabilityCenterMigration(database);
    return Response.json(
      {
        migration,
        verification,
        ...(!verification.passed ? { error: "capability_center_migration_incomplete" } : {}),
      },
      { status: verification.passed ? 200 : 409, headers: NO_STORE },
    );
  } catch (error) {
    return Response.json(
      {
        error: "capability_center_migration_failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500, headers: NO_STORE },
    );
  }
}
