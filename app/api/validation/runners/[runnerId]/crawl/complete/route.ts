import { completeCrawlJob, failCrawlJob } from "@/db/site-agent-store";
import { authorizeRunnerInstanceSession } from "@/db/runner-control-store";
import type { SiteKnowledgeDocument } from "@/lib/site-knowledge/crawl-knowledge";
import type { CrawlJob } from "@/lib/site-knowledge/protocol";
import { boundedJsonErrorStatus, readBoundedJson } from "@/lib/http/bounded-json";
import {
  legacyRunnerProtocolEnabled,
  runnerControlHeadersPlausible,
  runnerJson,
  runnerOptions,
  runnerSessionToken,
} from "../../../http";

type RouteContext = { params: Promise<{ runnerId: string }> | { runnerId: string } };
export async function OPTIONS() { return runnerOptions(); }
export async function POST(request: Request, context: RouteContext) {
  if (!runnerControlHeadersPlausible(request, { requireLease: true })) {
    return runnerJson({ error: "runner_unauthorized" }, 401);
  }
  const { runnerId } = await context.params;
  const decodedRunnerId = decodeURIComponent(runnerId);
  const token = request.headers.get("x-sitewake-lease-token") || "";
  const sessionToken = runnerSessionToken(request);
  try {
    await authorizeRunnerInstanceSession(decodedRunnerId, {
      sessionId: request.headers.get("x-sitewake-runner-session-id") || undefined,
      sessionToken,
      legacy: !sessionToken && legacyRunnerProtocolEnabled(),
    });
  } catch {
    return runnerJson({ error: "runner_unauthorized" }, 401);
  }
  let body: { siteAgentId?: string; jobId?: string; document?: SiteKnowledgeDocument; error?: string; contentFilter?: NonNullable<CrawlJob["result"]>["contentFilter"] };
  try {
    body = await readBoundedJson(request, 5 * 1024 * 1024);
  } catch (error) {
    const status = boundedJsonErrorStatus(error) || 400;
    return runnerJson(
      { error: status === 413 ? "crawl_document_too_large" : "invalid_json" },
      status,
    );
  }
  if (!body.siteAgentId || !body.jobId) return runnerJson({ error: "crawl_complete_payload_missing" }, 400);
  try {
    // A crawl that crashed mid-render reports `{ error }` with no document so the
    // job resolves as failed instead of hanging leased until the lease expires.
    if (!body.document) {
      if (!body.error) return runnerJson({ error: "crawl_complete_payload_missing" }, 400);
      const failure = await failCrawlJob(decodedRunnerId, token, body.jobId, body.error);
      return runnerJson({ failed: true, persistence: failure.persistence });
    }
    const result = await completeCrawlJob(decodedRunnerId, token, body.siteAgentId, body.jobId, body.document, body.contentFilter);
    return runnerJson({ persistence: result.persistence, releaseId: result.release?.id, version: result.release?.version });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return runnerJson(
      { error: "crawl_complete_failed", message },
      message === "crawl_job_missing"
        ? 404
        : message === "crawl_document_too_large"
          ? 413
          : message.startsWith("crawl_document_invalid")
            ? 400
        : message.startsWith("crawl_lease_")
          ? 409
          : 500,
    );
  }
}
