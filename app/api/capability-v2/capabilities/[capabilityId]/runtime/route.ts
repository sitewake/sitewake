import { withRequestTiming } from "@/lib/http/request-timing";
import { getCapability, getVersion } from "@/db/capability-center-v2-store";
import { getSiteAgentRunByToken, grantCompiledCapabilityExecution } from "@/db/agent-run-store";
import { runToken } from "@/app/api/agent-runs/http";
import { capabilityAgentAuthorized, capabilityJson, capabilityOptions, errorResponse, siteIdFromRequest } from "../../../http";
import { scopeMatchesRequest } from "@/lib/capability-center-v2/semantic-analyzer";
import { capabilityRunPage } from "@/lib/capability-center-v2/entry-page";
import type { JsonValue } from "@/lib/capability-center-v2/model";

export async function OPTIONS() { return capabilityOptions(); }

function decodedHeader(request: Request, name: string) {
  const value = request.headers.get(name) || "";
  try { return decodeURIComponent(value); } catch { return value; }
}

/**
 * Returns the immutable executable snapshot for the current Site browser.
 * Search and catalog responses intentionally stay lightweight; the Program is
 * fetched only after AgentPort has selected one Active capability.
 */
async function handleGET(request: Request, context: { params: Promise<{ capabilityId: string }> }) {
  const siteId = siteIdFromRequest(request);
  if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  if (!(await capabilityAgentAuthorized(request, siteId))) return capabilityJson({ error: "unauthorized" }, 401);
  try {
    const capabilityId = decodeURIComponent((await context.params).capabilityId || "");
    const capability = await getCapability(siteId, capabilityId);
    if (!capability || capability.status !== "Active") return capabilityJson({ error: "capability_not_available" }, 404);
    if (!capability.currentVersionId) return capabilityJson({ error: "capability_version_missing" }, 409);
    const version = await getVersion(siteId, capability.currentVersionId);
    if (!version || version.status !== "Published") return capabilityJson({ error: "capability_version_not_published" }, 409);
    let input: Record<string, JsonValue> = {};
    try {
      const raw = decodedHeader(request, "x-capability-input");
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, JsonValue>;
    } catch { return capabilityJson({ error: "capability_input_invalid" }, 400); }
    // A page the capability is bound to is somewhere to go, not a reason to
    // refuse: the scope is checked on the page it will run on, and the
    // program is handed back starting there.
    const runPage = capabilityRunPage(capability.contract, decodedHeader(request, "x-capability-current-url") || undefined);
    const scopeMatch = scopeMatchesRequest(capability.contract.scope, {
      goal: decodedHeader(request, "x-capability-goal"),
      input,
      currentUrl: runPage.url,
    });
    if (!scopeMatch.matched) return capabilityJson({ error: "capability_scope_mismatch", reason: scopeMatch.reason }, 409);
    const token = runToken(request);
    if (!token) return capabilityJson({ error: "agent_run_token_required" }, 401);
    const { run } = await getSiteAgentRunByToken(siteId, token, request.headers.get("origin"));
    const grant = await grantCompiledCapabilityExecution(run.id, {
      token,
      capabilityId: capability.id,
      versionId: version.id,
    });
    return capabilityJson({
      capabilityId: capability.id,
      versionId: version.id,
      name: capability.name,
      description: capability.description,
      contract: capability.contract,
      program: runPage.entry ? { ...version.program, entry: runPage.entry } : version.program,
      executionGrantId: grant.executionGrantId,
    });
  } catch (error) {
    return errorResponse(error, "capability_runtime_failed");
  }
}

export const GET = withRequestTiming("capability.runtime", handleGET);
