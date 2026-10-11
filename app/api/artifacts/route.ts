import { putBrowserArtifact } from "@/db/site-agent-store";
import { getArtifactBinding } from "@/db/index";
import type { BrowserArtifact } from "@/lib/site-knowledge/protocol";
import { browserArtifactContentType } from "@/lib/site-knowledge/browser-artifact-policy";
import { runnerAuthorized, siteAgentJson, siteAgentOptions } from "../site-agents/http";
import { authorizeRunnerInstanceSession } from "@/db/runner-control-store";
import { legacyRunnerProtocolEnabled, runnerSessionToken } from "../validation/runners/http";

export async function OPTIONS() { return siteAgentOptions(); }
function artifactLabel(request: Request, fallback: string) {
  const value = request.headers.get("x-sitewake-artifact-label") || fallback;
  try { return decodeURIComponent(value); } catch { return fallback; }
}
export async function POST(request: Request) {
  const runnerId = request.headers.get("x-sitewake-runner-id") || "";
  const sessionToken = runnerSessionToken(request);
  let authorized = false;
  if (runnerId && sessionToken) {
    try {
      await authorizeRunnerInstanceSession(runnerId, {
        sessionId: request.headers.get("x-sitewake-runner-session-id") || undefined,
        sessionToken,
        legacy: false,
      });
      authorized = true;
    } catch { /* handled as the normal unauthorized response below */ }
  } else if (legacyRunnerProtocolEnabled()) {
    authorized = runnerAuthorized(request);
  }
  if (!authorized) return siteAgentJson({ error: "runner_unauthorized" }, 401);
  const siteAgentId = request.headers.get("x-sitewake-site-agent-id") || new URL(request.url).searchParams.get("siteAgentId") || "";
  const learningJobId = request.headers.get("x-sitewake-learning-job-id") || "";
  const runId = request.headers.get("x-sitewake-run-id") || "";
  const kind = request.headers.get("x-sitewake-artifact-kind") as BrowserArtifact["kind"] | null;
  const role = request.headers.get("x-sitewake-artifact-role") as BrowserArtifact["role"] | null;
  const ownerKind = request.headers.get("x-sitewake-artifact-owner-kind") as BrowserArtifact["ownerKind"] | null;
  if (!siteAgentId || !learningJobId || !runId || !kind || !["video", "screenshot", "trace", "dom", "console"].includes(kind)
    || (ownerKind && !["learning-job", "preview-job"].includes(ownerKind))
    || (role && !["before-screenshot", "after-screenshot", "keyframe", "validation-video", "trace", "diagnostic", "site-preview"].includes(role))) return siteAgentJson({ error: "invalid_artifact_metadata" }, 400);
  const contentType = browserArtifactContentType(kind, request.headers.get("content-type"));
  if (!contentType) return siteAgentJson({ error: "invalid_artifact_content_type" }, 415);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (!getArtifactBinding() && contentLength > 2 * 1024 * 1024) return siteAgentJson({ error: "artifact_requires_r2", message: "Large browser evidence requires the ARTIFACTS R2 binding." }, 413);
  try {
    const artifact = await putBrowserArtifact({ siteAgentId, learningJobId, runId, ownerKind: ownerKind || "learning-job", kind, role: role || undefined, label: artifactLabel(request, kind), contentType, bytes: await request.arrayBuffer() });
    return siteAgentJson({ artifact }, 201);
  } catch (error) { return siteAgentJson({ error: "artifact_upload_failed", message: error instanceof Error ? error.message : "unknown" }, 500); }
}
