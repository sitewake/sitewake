import { adoptCrawlDocument } from "@/db/site-agent-store";
import type { SiteKnowledgeDocument } from "@/lib/site-knowledge/crawl-knowledge";
import { boundedJsonErrorStatus, readBoundedJson } from "@/lib/http/bounded-json";
import {
  brandedEnv,
  managementMutationAuthorized,
  siteAgentJson,
  siteAgentOptions,
} from "../../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
export async function OPTIONS() { return siteAgentOptions(); }

// Dev / preview path: adopt a crawl document directly as a base-layer release,
// no runner or lease. `scripts/crawl-preview.ts --adopt` posts here so the
// `view=model` topology shows crawled nodes without running the Node runner.
export async function POST(request: Request, context: RouteContext) {
  if (process.env.NODE_ENV === "production"
    && brandedEnv("ENABLE_DIRECT_CRAWL_ADOPT") !== "1") {
    return siteAgentJson({ error: "not_found" }, 404);
  }
  if (!(await managementMutationAuthorized(request))) {
    return siteAgentJson({ error: "unauthorized" }, 401);
  }
  const { siteAgentId } = await context.params;
  let body: { document?: SiteKnowledgeDocument };
  try {
    body = await readBoundedJson(request, 5 * 1024 * 1024);
  } catch (error) {
    const status = boundedJsonErrorStatus(error) || 400;
    return siteAgentJson(
      { error: status === 413 ? "crawl_document_too_large" : "invalid_json" },
      status,
    );
  }
  if (!body.document || body.document.schemaVersion !== "site-knowledge/v1") {
    return siteAgentJson({ error: "crawl_document_invalid" }, 400);
  }
  try {
    const result = await adoptCrawlDocument(decodeURIComponent(siteAgentId), body.document);
    return siteAgentJson({ releaseId: result.release?.id, version: result.release?.version, scenes: body.document.scenes.length, persistence: result.persistence });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return siteAgentJson(
      { error: "crawl_adopt_failed", message },
      message === "crawl_document_too_large"
        ? 413
        : message.startsWith("crawl_document_invalid")
          ? 400
          : message === "crawl_adopt_contended"
            ? 409
            : 500,
    );
  }
}
