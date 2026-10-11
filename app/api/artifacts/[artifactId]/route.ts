import { getBrowserArtifact } from "@/db/site-agent-store";
import { browserArtifactContentType, browserArtifactDisposition, browserArtifactExtension } from "@/lib/site-knowledge/browser-artifact-policy";
import { managementAuthorized } from "../../site-agents/http";

type RouteContext = { params: Promise<{ artifactId: string }> | { artifactId: string } };
export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return new Response("Unauthorized", { status: 401 });
  const { artifactId } = await context.params;
  const result = await getBrowserArtifact(decodeURIComponent(artifactId));
  if (!result) return new Response("Not found", { status: 404 });
  const contentType = browserArtifactContentType(result.artifact.kind, result.artifact.contentType) || "application/octet-stream";
  const disposition = browserArtifactDisposition(result.artifact.kind);
  const safeId = result.artifact.id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filename = `${safeId}${browserArtifactExtension(result.artifact.kind, contentType)}`;
  return new Response(result.object.body, { headers: {
    "content-type": contentType,
    "content-length": String(result.object.size),
    "cache-control": "private, no-store",
    "content-disposition": `${disposition}; filename="${filename}"`,
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  } });
}
