import {
  cancelCrawlJobs,
  enqueueCrawlJob,
  getSiteAgentOverview,
  listCrawlJobs,
  siteAgentExists,
} from "@/db/site-agent-store";
import type { CrawlJobLimits } from "@/lib/site-knowledge/protocol";
import { validateCrawlJobLimits } from "@/lib/site-knowledge/crawl-limits";
import { managementAuthorized, managementMutationAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
export async function OPTIONS() { return siteAgentOptions(); }

// DELETE: clear unfinished crawl jobs (dismiss a job stuck with no runner).
export async function DELETE(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId } = await context.params;
  try {
    const result = await cancelCrawlJobs(decodeURIComponent(siteAgentId));
    return siteAgentJson({ cleared: result.cleared, persistence: result.persistence });
  } catch (error) {
    return siteAgentFailure(error, "crawl_cancel_failed");
  }
}

// GET: crawl-job status for this site agent (drives the console panel).
export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) {
    return siteAgentJson({ error: "unauthorized" }, 401);
  }
  const { siteAgentId } = await context.params;
  try {
    const result = await listCrawlJobs(decodeURIComponent(siteAgentId));
    return siteAgentJson({ jobs: result.jobs, persistence: result.persistence });
  } catch (error) {
    return siteAgentFailure(error, "crawl_list_failed");
  }
}

// POST: enqueue a crawl of `origin`. Same management surface as overview/config —
// crawl completion runs on the Node runner (the Worker runtime cannot render pages).
export async function POST(request: Request, context: RouteContext) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId } = await context.params;
  const decodedSiteAgentId = decodeURIComponent(siteAgentId);
  if (!(await siteAgentExists(decodedSiteAgentId))) return siteAgentJson({ error: "site_agent_not_found" }, 404);
  const body = await request.json().catch(() => ({})) as { origin?: string; seeds?: string[]; limits?: CrawlJobLimits };
  if (!body.origin) return siteAgentJson({ error: "crawl_origin_required" }, 400);
  let origin: string;
  let seeds: string[];
  let limits: CrawlJobLimits | undefined;
  try {
    limits = validateCrawlJobLimits(body.limits);
    const requestedOrigin = new URL(body.origin);
    if (!/^https?:$/.test(requestedOrigin.protocol)) throw new Error("crawl_origin_protocol_invalid");
    if (requestedOrigin.username || requestedOrigin.password) throw new Error("crawl_origin_userinfo_invalid");
    origin = requestedOrigin.origin;
    seeds = [...new Set((body.seeds || []).map((value) => {
      const seed = new URL(value);
      if (!/^https?:$/.test(seed.protocol)) throw new Error("crawl_seed_protocol_invalid");
      if (seed.username || seed.password) throw new Error("crawl_seed_userinfo_invalid");
      if (seed.origin !== origin) throw new Error("crawl_seed_origin_invalid");
      return seed.toString();
    }))];
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return siteAgentJson({
      error: code === "crawl_seed_origin_invalid"
        || code === "crawl_seed_protocol_invalid"
        || code === "crawl_seed_userinfo_invalid"
        || code === "crawl_limits_invalid"
        || code.startsWith("crawl_limit_invalid:")
        ? code
        : "crawl_origin_invalid",
    }, 400);
  }
  const { overview } = await getSiteAgentOverview(decodedSiteAgentId);
  const allowedOrigins = new Set([
    overview.connection?.origin,
    overview.connection?.url,
    overview.activeRelease.profile.entryUrl,
    ...(overview.activeRelease.profile.allowedOrigins || []),
  ].flatMap((value) => {
    try { return value ? [new URL(value).origin] : []; } catch { return []; }
  }));
  if (!allowedOrigins.has(origin)) return siteAgentJson({ error: "crawl_origin_not_allowed" }, 403);
  try {
    const result = await enqueueCrawlJob({
      siteAgentId: decodedSiteAgentId,
      origin,
      seeds,
      limits,
    });
    return siteAgentJson({ jobId: result.job?.id, status: result.job?.status, persistence: result.persistence });
  } catch (error) {
    return siteAgentFailure(error, "crawl_enqueue_failed");
  }
}
