import { NextRequest } from "next/server";
import { createSiteAgent, listSiteAgents } from "../../../db/site-agent-store";
import { resolveSiteAddress } from "../../../lib/site-knowledge/site-address";
import { classifySiteAgentError } from "../../../lib/site-knowledge/errors";
import { brandedEnv, managementAuthorized, managementMutationAuthorized, persistenceHeaders, siteAgentJson, siteAgentOptions } from "./http";

export async function OPTIONS() {
  return siteAgentOptions();
}

export async function GET(request: NextRequest) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const localDevelopment =
    brandedEnv("LOCAL_DEV") === "1" &&
    process.env.NODE_ENV !== "production";
  try {
    const listed = await listSiteAgents();
    // Local development hides throwaway fixtures left behind by smoke tests.
    // Demo sites are registered through this same public API by the playground
    // launcher, so no site is ever created here as a side effect of a listing.
    const result = localDevelopment
      ? {
          ...listed,
          agents: listed.agents.filter(
            (agent) =>
              !/^(?:missing$|smoke[-_]|ux-smoke[-_]|__container_smoke__)/i.test(
                agent.id,
              ),
          ),
        }
      : listed;
    return siteAgentJson(result, 200, {
      ...persistenceHeaders(listed.persistence),
      "cache-control": "no-store",
    });
  } catch (error) {
    const classified = classifySiteAgentError(error, "site_agent_lookup_failed", "site_agent_lookup");
    const code = classified.code === "site_agent_lookup_failed" ? "site_agent_list_failed" : classified.code;
    console.error("site_agent_list_failed", {
      code,
      phase: classified.phase,
      status: classified.status,
      message: error instanceof Error ? error.message : String(error),
    });
    return siteAgentJson({ error: code, message: classified.message, retryable: classified.retryable, phase: classified.phase }, classified.status);
  }
}

export async function POST(request: NextRequest) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  let body: Record<string, unknown> = {};
  try { body = await request.json() as Record<string, unknown>; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  try {
    // Register the address the site actually serves: a bare domain that
    // redirects to www is the same website, and everything downstream — the
    // snippet handed to the reader, the preview, the crawl, the origins the
    // handshake is checked against — has to name the address a browser lands
    // on. A redirect off the site, or a site that cannot be reached right now,
    // leaves the operator's address as it is.
    const url = await resolveSiteAddress(String(body.url || ""));
    const result = await createSiteAgent({ id: String(body.id || ""), name: String(body.name || ""), description: String(body.description || ""), url });
    return siteAgentJson(result, 201, persistenceHeaders(result.persistence));
  } catch (error) {
    return siteAgentJson({ error: "site_agent_create_failed", message: error instanceof Error ? error.message : "unknown" }, 500);
  }
}
