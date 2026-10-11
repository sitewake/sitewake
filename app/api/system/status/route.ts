import { getArtifactBinding, getD1Binding } from "../../../../db";
import { publicModelStatus } from "../../../../lib/model-config";
import { managementAuthorized, siteAgentJson } from "../../site-agents/http";

/** Configuration metadata only: no provider requests, secrets or site dependency. */
export async function GET(request: Request) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  try {
    const database = getD1Binding();
    const host = new URL(request.url).hostname;
    return siteAgentJson({
      environment: ["localhost", "127.0.0.1", "[::1]"].includes(host) ? "development" : database?.dialect === "postgres" ? "container" : "cloudflare",
      database: database ? database.dialect === "postgres" ? "PostgreSQL" : "SQLite / D1" : "memory",
      artifactsConfigured: Boolean(getArtifactBinding()),
      build: process.env.SITEWAKE_BUILD_SHA || process.env.SITEWAKE_BUILD_SHA || "development",
      models: { general: publicModelStatus("general"), execution: publicModelStatus("execution"), semantic: publicModelStatus("semantic") },
    }, 200, { "cache-control": "no-store" });
  } catch { return siteAgentJson({ error: "system_status_unavailable" }, 503); }
}
