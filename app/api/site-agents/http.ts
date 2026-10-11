import { NextResponse } from "next/server";
import { ACCESS_COOKIE_NAME, authorizeManagementSession } from "../../../lib/access-control";

export const SITE_AGENT_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  // Every product-prefixed header, including the runner-protocol ones
  // (`runner-token`, `lease-token`, `artifact-*`), is spelled `x-sitewake-*`.
  "access-control-allow-headers": "content-type,authorization,idempotency-key,if-none-match,x-sitewake-site-agent-id,x-sitewake-run-id,x-sitewake-learning-job-id,x-sitewake-ai-stage,x-sitewake-site-id,x-sitewake-runner-token,x-sitewake-lease-token,x-sitewake-artifact-kind,x-sitewake-artifact-role,x-sitewake-artifact-owner-kind,x-sitewake-artifact-label",
  "access-control-expose-headers": "etag,x-sitewake-persistence",
  "cache-control": "no-store",
  "cdn-cache-control": "no-store",
  "cloudflare-cdn-cache-control": "no-store",
};

/** Read one product-prefixed variable. `SITEWAKE_*` is the only name that is read. */
export function brandedEnv(suffix: string) {
  return process.env[`SITEWAKE_${suffix}`]?.trim() || "";
}

function runnerTokenAuthorized(request: Request, allowUnconfigured: boolean) {
  const configured = process.env.SITEWAKE_RUNNER_TOKEN?.trim();
  if (!configured) return allowUnconfigured;
  const authorization = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return authorization === configured || request.headers.get("x-sitewake-runner-token") === configured;
}

export function runnerAuthorized(request: Request) {
  return runnerTokenAuthorized(request, true);
}

/** Origin-less AgentRun controllers are service authority and must fail closed. */
export function strictRunnerAuthorized(request: Request) {
  return runnerTokenAuthorized(request, false);
}

function configuredPublicOrigins() {
  const values = [
    brandedEnv("PUBLIC_ORIGIN"),
    brandedEnv("PUBLIC_HOSTNAME"),
    process.env.CLOUDFLARE_ROUTE_HOSTNAME,
  ];
  return [...new Set(values.flatMap((value) => {
    const raw = value?.trim();
    if (!raw) return [];
    try { return [new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin]; }
    catch { return []; }
  }))];
}

/**
 * The address this control plane actually answers at, as the browser sees it.
 * A TLS-terminating proxy or a cloud tunnel reaches the app over plain http
 * and names the public scheme and host in forwarded headers; without them the
 * request URL is the address.
 */
function effectiveRequestOrigin(request: Request) {
  const url = new URL(request.url);
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedProtocol === "http" || forwardedProtocol === "https") url.protocol = `${forwardedProtocol}:`;
  if (forwardedHost) {
    // The `host` setter keeps the port the request arrived on, which is the
    // internal one; a forwarded host carries its own port or none at all.
    const [hostname, port = ""] = forwardedHost.startsWith("[")
      ? [forwardedHost.slice(0, forwardedHost.indexOf("]") + 1), forwardedHost.slice(forwardedHost.indexOf("]") + 2)]
      : forwardedHost.split(":");
    try {
      url.hostname = hostname;
      url.port = port;
    } catch { /* a malformed forwarded host leaves the real one in place */ }
  }
  return url.origin;
}

/**
 * The Origin a browser must present to manage this control plane. A
 * self-hosted console is opened at whatever address its owner can reach —
 * localhost, a LAN or bridge IP, a cloud tunnel, a domain behind a TLS proxy —
 * so the address this request arrived at is authoritative for itself, and a
 * configured public origin additionally covers a proxy that rewrites Host.
 * A request from any other site is what the check exists to refuse.
 */
export function controlPlaneOriginForRequest(request: Request) {
  return effectiveRequestOrigin(request);
}

export async function managementAuthorized(request: Request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const encoded = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${ACCESS_COOKIE_NAME}=`))
    ?.slice(ACCESS_COOKIE_NAME.length + 1);
  if (!encoded) return authorizeManagementSession(undefined);
  try {
    return authorizeManagementSession(decodeURIComponent(encoded));
  } catch {
    // A malformed cookie is an authentication failure, not an uncaught route
    // exception.  The caller still receives the normal 401 response.
    return false;
  }
}

/**
 * Cookie-authenticated management mutations must also prove that the browser
 * initiated the request from this exact control-plane origin. Requiring
 * Origin closes same-site CSRF paths that session cookies alone cannot.
 */
export async function managementMutationAuthorized(request: Request) {
  const originHeader = request.headers.get("origin")?.trim();
  if (!originHeader) return false;
  let requestOrigin: string;
  try {
    requestOrigin = new URL(originHeader).origin;
  } catch {
    return false;
  }
  const controlPlaneOrigin = controlPlaneOriginForRequest(request);
  if (requestOrigin !== controlPlaneOrigin && !configuredPublicOrigins().includes(requestOrigin)) return false;
  return managementAuthorized(request);
}

/**
 * Deployment-only maintenance authority. This deliberately does not reuse the
 * browser management cookie: a release must be able to run idempotent storage
 * migrations before any worker is resumed, including on access-locked sites.
 *
 * The token is generated by the deploy script, injected only into the
 * control-plane container, and presented by a loopback request from that same
 * container.
 */
export async function internalMaintenanceAuthorized(request: Request) {
  const expected = brandedEnv("MAINTENANCE_TOKEN");
  const presented = brandedHeader(request, "maintenance-token")?.trim();
  if (!expected || !presented) return false;
  const encoder = new TextEncoder();
  const [expectedDigest, presentedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
  ]);
  const expectedBytes = new Uint8Array(expectedDigest);
  const presentedBytes = new Uint8Array(presentedDigest);
  let mismatch = expectedBytes.length ^ presentedBytes.length;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    mismatch |= expectedBytes[index]! ^ (presentedBytes[index] || 0);
  }
  return mismatch === 0;
}

/** Read one product-prefixed request header. `x-sitewake-*` is the only name that is read. */
export function brandedHeader(request: Request, suffix: string) {
  return request.headers.get(`x-sitewake-${suffix}`) || null;
}

export function persistenceHeaders(persistence: string) {
  return { "x-sitewake-persistence": persistence };
}

export function siteAgentJson(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(body, {
    status,
    headers: { ...SITE_AGENT_CORS_HEADERS, ...headers },
  });
}

/**
 * A missing site is 404, not 500. The store throws `site_agent_not_found` on every
 * non-create path for an unknown site (see `memoryAgent` / `requireD1Agent` in
 * `db/site-agent-store.ts`); each route's fallback catch must recognize it first, and
 * only the rest counts as the route's own failure.
 */
export function siteAgentNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === "site_agent_not_found" || message === "site_agent_not_found";
}

export function siteAgentFailure(error: unknown, fallbackCode: string, status = 500, headers: Record<string, string> = {}) {
  if (siteAgentNotFoundError(error)) return siteAgentJson({ error: "site_agent_not_found" }, 404, headers);
  return siteAgentJson({ error: fallbackCode, message: error instanceof Error ? error.message : "unknown" }, status, headers);
}

export function siteAgentOptions() {
  return new NextResponse(null, {
    status: 204,
    headers: SITE_AGENT_CORS_HEADERS,
  });
}
