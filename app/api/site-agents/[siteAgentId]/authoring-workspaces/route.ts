import { saveAuthoringWorkspace } from "../../../../../db/site-agent-store";
import type { PersistedAuthoringWorkspace } from "../../../../../lib/site-knowledge/protocol";
import { persistenceHeaders, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
export async function OPTIONS() { return siteAgentOptions(); }

/**
 * Persist an authoring workspace snapshot produced by the container
 * authoring-worker (the VFS the coding agent wrote). This is authoring-craft
 * evidence for the Capability Center workbench; it never enters a Release.
 */
export async function POST(request: Request, context: RouteContext) {
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  let workspace: PersistedAuthoringWorkspace;
  try {
    const body = await request.json() as { workspace?: PersistedAuthoringWorkspace };
    workspace = body.workspace as PersistedAuthoringWorkspace;
  } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  if (!siteAgentId || !workspace || typeof workspace !== "object") return siteAgentJson({ error: "invalid_workspace" }, 400);
  if (workspace.siteAgentId !== siteAgentId || !workspace.projectId || !Array.isArray(workspace.files)) {
    return siteAgentJson({ error: "invalid_workspace_shape" }, 400);
  }
  try {
    const result = await saveAuthoringWorkspace(workspace);
    return siteAgentJson({ accepted: true }, 202, persistenceHeaders(result.persistence));
  } catch (error) {
    return siteAgentFailure(error, "authoring_workspace_save_failed");
  }
}
