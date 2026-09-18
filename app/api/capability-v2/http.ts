import { NextResponse } from "next/server";
import { managementAuthorized, managementMutationAuthorized } from "../site-agents/http";
import { CapabilityCenterV2Error } from "@/db/capability-center-v2-store";
import { getSiteAgentOverview } from "@/db/site-agent-store";

export const CAPABILITY_V2_HEADERS = {
  "cache-control": "no-store",
  "cdn-cache-control": "no-store",
  "cloudflare-cdn-cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,idempotency-key,last-event-id,x-sitewake-site-id,x-sitewake-site-agent-id,x-capability-runner-id,x-capability-runner-token,x-capability-input,x-capability-goal,x-capability-current-url",
};

export function capabilityJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...CAPABILITY_V2_HEADERS, ...headers } });
}

export function capabilityOptions() { return new NextResponse(null, { status: 204, headers: CAPABILITY_V2_HEADERS }); }

export async function capabilityReadAuthorized(request: Request) {
  if (await managementAuthorized(request)) return true;
  return process.env.SITEWAKE_LOCAL_DEV === "1" && process.env.NODE_ENV !== "production";
}

export async function capabilityWriteAuthorized(request: Request) {
  if (await managementMutationAuthorized(request)) return true;
  return process.env.SITEWAKE_LOCAL_DEV === "1" && process.env.NODE_ENV !== "production";
}

export async function capabilityAgentAuthorized(request: Request, siteId: string) {
  if (await capabilityReadAuthorized(request)) return true;
  const assertedSiteId = request.headers.get("x-sitewake-site-agent-id")?.trim();
  if (!siteId || assertedSiteId !== siteId) return false;
  let callerOrigin = request.headers.get("origin")?.trim();
  if (!callerOrigin) {
    try { callerOrigin = new URL(request.headers.get("referer") || "").origin; } catch { return false; }
  }
  try {
    const { overview } = await getSiteAgentOverview(siteId);
    const registeredOrigin = overview.connection?.origin || (overview.connection?.url ? new URL(overview.connection.url).origin : undefined);
    return Boolean(registeredOrigin && new URL(callerOrigin).origin === new URL(registeredOrigin).origin);
  } catch { return false; }
}

export { assertCapabilityStartUrl } from "@/lib/capability-center-v2/site-entry-policy";

export function siteIdFromRequest(request: Request, body?: Record<string, unknown>) {
  const value = request.headers.get("x-sitewake-site-id") || new URL(request.url).searchParams.get("siteId") || body?.siteId;
  return typeof value === "string" ? value.trim() : "";
}

export function runnerAuthorized(request: Request) {
  const configured = process.env.CAPABILITY_V2_DISPATCH_TOKEN?.trim()
    || process.env.CAPABILITY_V2_RUNNER_TOKEN?.trim();
  if (!configured) return process.env.SITEWAKE_LOCAL_DEV === "1" && process.env.NODE_ENV !== "production";
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return bearer === configured || request.headers.get("x-capability-runner-token") === configured;
}

export function errorResponse(error: unknown, fallback = "capability_center_v2_failed") {
  if (error instanceof CapabilityCenterV2Error) return capabilityJson({ error: error.code, message: error.message }, error.status);
  return capabilityJson({ error: fallback, message: error instanceof Error ? error.message : "unknown" }, 500);
}
