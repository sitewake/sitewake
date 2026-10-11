import { NextRequest } from "next/server";
import { originIsRegistered } from "@/lib/console/site-addresses";
import {
  createSiteAgent,
  enqueueInitialCrawlJob,
  enqueueSitePreviewJob,
  getActiveSiteAgentRelease,
  recordSiteAgentConnection,
  siteAgentExists,
} from "../../../../../db/site-agent-store";
import { initialCrawlSeeds } from "../../../../../lib/site-knowledge/initial-crawl";
import type { PageSnapshot } from "../../../../../lib/site-knowledge/protocol";
import { controlPlaneOriginForRequest, managementAuthorized, persistenceHeaders, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";
import { siteAgentRuntimeFeatures } from "../../../../../lib/site-knowledge/runtime-features";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
export async function OPTIONS() { return siteAgentOptions(); }

export async function POST(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  if (!siteAgentId || !body.snapshot || typeof body.snapshot !== "object") return siteAgentJson({ error: "connection_snapshot_required" }, 400);
  try {
    const snapshot = body.snapshot as PageSnapshot;
    const url = new URL(snapshot.url);
    const requestOriginHeader = request.headers.get("origin")?.trim();
    if (!requestOriginHeader) return siteAgentJson({ error: "site_agent_origin_rejected" }, 403);
    let requestOrigin: string;
    try { requestOrigin = new URL(requestOriginHeader).origin; }
    catch { return siteAgentJson({ error: "site_agent_origin_rejected" }, 403); }
    const controlPlaneOrigin = controlPlaneOriginForRequest(request);
    if (requestOrigin !== url.origin) return siteAgentJson({ error: "site_agent_origin_rejected" }, 403);
    const exists = await siteAgentExists(siteAgentId);
    // The bundled demo may bootstrap itself because its code is hosted by this
    // control plane. Cross-Origin SDK connections must be enrolled first via
    // the management-protected Site creation endpoint.
    if (!exists) {
      if (requestOrigin !== controlPlaneOrigin || !(await managementAuthorized(request))) {
        return siteAgentJson({ error: "site_agent_not_found" }, 404);
      }
      await createSiteAgent({ id: siteAgentId, url: snapshot.url });
    }
    const active = await getActiveSiteAgentRelease(siteAgentId);
    const configuredOriginValues = active?.release?.profile?.allowedOrigins;
    const configuredOrigins = (Array.isArray(configuredOriginValues) ? configuredOriginValues : []).flatMap((value: string) => {
      try { return [new URL(value).origin]; } catch { return []; }
    });
    if (requestOrigin !== controlPlaneOrigin && !originIsRegistered(configuredOrigins, requestOrigin)) {
      // Name the reason and both sides of it: the SDK prints this in the page's
      // own console, which is where a developer is looking when the widget does
      // not appear. These are the site's own public addresses, not secrets.
      return siteAgentJson({
        error: "site_agent_origin_rejected",
        reason: "origin_not_registered",
        origin: requestOrigin,
        registered: configuredOrigins,
      }, 403);
    }
    // The console's rehearsal serves the reader's page with the snippet in it
    // to find out what a browser does with it. The SDK boots and handshakes
    // exactly as it would in production, which is the point — but the website
    // has installed nothing, so nothing about it may be recorded.
    const rehearsal = body.rehearsal === true;
    const visibility = body.visibility === "sandbox" || body.visibility === "system" ? body.visibility : "production";
    // A rehearsal gets everything it needs to run — the Release — and leaves no
    // trace: no connection record, no preview, no crawl. Recording it would tell
    // the reader their website is connected when they have installed nothing,
    // which is exactly what the check exists to find out.
    if (rehearsal) {
      const active = await getActiveSiteAgentRelease(siteAgentId);
      const rehearsedRelease = active?.release;
      if (!rehearsedRelease) return siteAgentJson({ error: "site_agent_not_found" }, 404);
      return siteAgentJson({
        connection: null,
        rehearsal: true,
        persistence: "memory",
        release: { ...rehearsedRelease, runtimeFeatures: siteAgentRuntimeFeatures(siteAgentId) },
        knowledgeReview: { queued: false },
      }, 200);
    }
    // Every page load takes this path; it only records the connection, producing no
    // knowledge. Latency-sensitive: deterministic page facts are stored at once, and no
    // semantic processing may make the agent look disconnected for 45 seconds.
    const result = await recordSiteAgentConnection(siteAgentId, {
      origin: url.origin,
      url: snapshot.url,
      title: snapshot.title,
      heading: snapshot.heading,
      snapshot,
      visibility,
    });
    // Visual confirmation is a short, idempotent task. It is isolated from
    // knowledge collection and may fail without affecting the connection.
    await enqueueSitePreviewJob({ siteAgentId, origin: url.origin, url: snapshot.url }).catch(() => undefined);
    // Site knowledge comes from crawling only: a connection no longer triggers the AI
    // review or learns structure from this page. Review is a step of the crawl (see
    // completeCrawlJob), not a visit-triggered background job.
    //
    // But the crawl itself may be started by the **first connection**: when this
    // handshake creates a connection record that did not exist, schedule one crawl for
    // the user — no need to click "read now" on the knowledge page. A single insert, only
    // when the site never had a crawl job (at most one concurrent first handshake wins);
    // a failed enqueue does not affect the handshake.
    if (result.firstConnection) {
      await enqueueInitialCrawlJob({
        siteAgentId,
        origin: url.origin,
        seeds: initialCrawlSeeds(snapshot.url, result.release.profile.entryUrl),
      }).catch((error: unknown) => {
        console.error("initial_crawl_enqueue_failed", { siteAgentId, message: error instanceof Error ? error.message : String(error) });
      });
    }
    //
    // `/connection` and `/release?runtime=1` race on every document load. Both
    // boundaries must return the same runtime feature projection, or a late connection
    // response switches Evidence V2 off mid-handoff.
    const release = {
      ...result.release,
      runtimeFeatures: siteAgentRuntimeFeatures(siteAgentId),
    };
    // `firstConnection` is a server-side signal and is not in the response: the handshake response shape does not change for auto crawl.
    return siteAgentJson({ connection: result.connection, persistence: result.persistence, release, knowledgeReview: { queued: false } }, 200, persistenceHeaders(result.persistence));
  } catch (error) {
    return siteAgentFailure(error, "site_agent_connection_failed");
  }
}
