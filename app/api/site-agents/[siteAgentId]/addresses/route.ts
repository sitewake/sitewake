import { createSiteAgent, getActiveSiteAgentRelease, siteAgentAccess, siteAgentExists } from "@/db/site-agent-store";
import { normalizeSiteAddresses } from "@/lib/console/site-addresses";
import { managementAuthorized, managementMutationAuthorized, siteAgentJson, siteAgentFailure } from "../../http";

/**
 * The set of addresses this website answers at. The handshake accepts a page
 * only from one of them, so this is where a second one (www, staging, a port)
 * is added — deliberately, by a person, never by a check that happened to see
 * a redirect.
 */

type RouteContext = { params: Promise<{ siteAgentId: string }> };

async function resolve(request: Request, context: RouteContext, mutating: boolean) {
  const authorized = mutating ? await managementMutationAuthorized(request) : await managementAuthorized(request);
  if (!authorized) return { error: siteAgentJson({ error: "unauthorized" }, 401) };
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  if (!siteAgentId) return { error: siteAgentJson({ error: "site_agent_id_required" }, 400) };
  if (!(await siteAgentExists(siteAgentId))) return { error: siteAgentJson({ error: "site_agent_not_found" }, 404) };
  const access = await siteAgentAccess(siteAgentId);
  if (access !== "allowed") return { error: siteAgentJson({ error: access === "forbidden" ? "site_agent_forbidden" : "site_agent_not_found" }, access === "forbidden" ? 403 : 404) };
  return { siteAgentId };
}

async function currentAddresses(siteAgentId: string) {
  const active = await getActiveSiteAgentRelease(siteAgentId);
  const profile = active?.release?.profile;
  const configured = Array.isArray(profile?.allowedOrigins) ? profile.allowedOrigins : [];
  return {
    addresses: normalizeSiteAddresses(configured).origins,
    entryUrl: profile?.entryUrl || "",
  };
}

export async function GET(request: Request, context: RouteContext) {
  const resolved = await resolve(request, context, false);
  if ("error" in resolved) return resolved.error;
  try {
    return siteAgentJson(await currentAddresses(resolved.siteAgentId), 200, { "cache-control": "no-store" });
  } catch (error) {
    return siteAgentFailure(error, "site_agent_addresses_failed");
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const resolved = await resolve(request, context, true);
  if ("error" in resolved) return resolved.error;
  let body: { addresses?: unknown };
  try { body = await request.json() as { addresses?: unknown }; }
  catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  if (!Array.isArray(body.addresses)) return siteAgentJson({ error: "addresses_required" }, 400);
  const { origins, rejected } = normalizeSiteAddresses(body.addresses.map((value) => String(value)));
  if (rejected.length) return siteAgentJson({ error: "site_address_rejected", rejected }, 400);
  // A website with no address at all could never hand shake; that is a mistake,
  // not a configuration.
  if (!origins.length) return siteAgentJson({ error: "addresses_required" }, 400);
  try {
    await createSiteAgent({ id: resolved.siteAgentId, profile: { allowedOrigins: origins } });
    return siteAgentJson(await currentAddresses(resolved.siteAgentId), 200, { "cache-control": "no-store" });
  } catch (error) {
    return siteAgentFailure(error, "site_agent_addresses_failed");
  }
}
