import { getTaskArtifact } from "@/db/capability-center-v2-store";
import {
  capabilityJson,
  capabilityOptions,
  capabilityReadAuthorized,
  siteIdFromRequest,
} from "@/app/api/capability-v2/http";

type Context = {
  params: Promise<{ artifactId: string }> | { artifactId: string };
};
export async function OPTIONS() {
  return capabilityOptions();
}
export async function GET(request: Request, context: Context) {
  if (!(await capabilityReadAuthorized(request)))
    return capabilityJson({ error: "unauthorized" }, 401);
  const siteId = siteIdFromRequest(request);
  const params = await context.params;
  if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  const stored = await getTaskArtifact(
    siteId,
    decodeURIComponent(params.artifactId || ""),
  );
  if (!stored) return capabilityJson({ error: "artifact_not_found" }, 404);
  const extension = stored.artifact.contentType.startsWith("application/vnd.sitewake.workspace") ? "workspace.json.gz" : "bin";
  const body = "stream" in stored ? stored.stream : stored.bytes;
  return new Response(body as BodyInit, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${stored.artifact.id}.${extension}"`,
      "content-length": String(stored.artifact.size),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, no-store",
    },
  });
}
