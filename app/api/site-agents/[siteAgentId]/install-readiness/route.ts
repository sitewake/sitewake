import { getSiteAgentOverview, getSitePreview, siteAgentAccess } from "@/db/site-agent-store";
import { assessInstallReadiness, cspAllowsOrigin, parseCsp, type InstallReadiness } from "@/lib/console/install-readiness";
import { policyOrigin, policyPatch, policyVerdictFromViolations, type PolicyVerdict } from "@/lib/console/policy-findings";
import { getPublicAddress } from "@/lib/public-address";
import { controlPlaneOriginForRequest, managementAuthorized, siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";

/**
 * What the console needs to know before it hands out an install snippet: does
 * the site's own Content-Security-Policy admit this control plane, and does the
 * address answer where it was registered.
 *
 * The policy answer comes from the browser whenever there is one: a rehearsal
 * (see runner/site-preview-rehearsal.ts) opens the page with the snippet in it
 * and reports what was refused. Reading the policy text is the fallback, and it
 * is labelled as inferred — telling a reader to change a directive that would
 * not have mattered is how the previous version wasted their time.
 */
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
export async function OPTIONS() { return siteAgentOptions(); }

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_BYTES = 64 * 1024;

function unreachable(error: unknown): InstallReadiness["unreachable"] {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const detail = `${message}${cause ? `: ${cause}` : ""}`.slice(0, 200);
  // A TLS failure is worth naming on its own: the site is reachable, its
  // certificate is not usable, and no browser or runner will accept it either.
  if (/certificate|self[- ]signed|CERT_|TLS|SSL/i.test(detail)) return { reason: "certificate", detail };
  return { reason: "network", detail };
}

export async function GET(request: Request, context: RouteContext) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const { siteAgentId: rawId } = await context.params;
  const siteAgentId = decodeURIComponent(rawId || "").trim();
  const access = await siteAgentAccess(siteAgentId);
  if (access === "not_found") return siteAgentJson({ error: "site_agent_not_found" }, 404);
  if (access === "forbidden") return siteAgentJson({ error: "site_agent_forbidden" }, 403);
  try {
    const { overview } = await getSiteAgentOverview(siteAgentId);
    const requested = new URL(request.url).searchParams.get("url")?.trim();
    const siteUrl = requested || overview?.activeRelease?.profile?.entryUrl || "";
    if (!siteUrl) return siteAgentJson({ error: "site_url_required" }, 400);
    // The snippet carries the configured public address; the address this
    // request happens to have arrived at is only the fallback for an
    // installation that has never set one.
    const sdkOrigin = getPublicAddress().origin || controlPlaneOriginForRequest(request);
    // The address is the site the operator registered, so it is not an open
    // proxy; it is still worth keeping the probe small and bounded.
    let response: Response | undefined;
    let html = "";
    let failure: InstallReadiness["unreachable"];
    try {
      response = await fetch(siteUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { "user-agent": "SiteWake-Console-InstallCheck/1.0", accept: "text/html,*/*" },
      });
      const body = response.body;
      if (body) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let read = 0;
        while (read < PROBE_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          read += value.byteLength;
          html += decoder.decode(value, { stream: true });
        }
        await reader.cancel().catch(() => undefined);
      }
      if (!response.ok) failure = { reason: "status", detail: `HTTP ${response.status}` };
    } catch (error) {
      failure = unreachable(error);
    }
    const readiness = assessInstallReadiness({
      siteUrl,
      sdkOrigin,
      finalUrl: response?.url || undefined,
      cspHeader: response?.headers.get("content-security-policy")
        || response?.headers.get("content-security-policy-report-only")
        || undefined,
      html,
      headers: response ? [...response.headers] : undefined,
      unreachable: failure,
    });
    // What the browser actually did, if a rehearsal or a live render has run.
    const measured = await measuredPolicy(siteAgentId, sdkOrigin);
    const rehearsal = await rehearsalEvidence(siteAgentId);
    const policy: PolicyVerdict | { source: "unknown" } = measured
      || inferredPolicy({ readiness, html, response, sdkOrigin });
    const platform = response ? policyOrigin([...response.headers]) : undefined;
    return siteAgentJson({ readiness, sdkOrigin, policy, ...(rehearsal ? { rehearsal } : {}), ...(platform ? { platform } : {}) });
  } catch (error) {
    return siteAgentFailure(error, "site_agent_install_readiness_failed");
  }
}

/**
 * The verdict a browser produced, when one has. A rehearsal that could not
 * place the snippet proves nothing and is ignored here, so the caller falls
 * back to reading the policy text and says that it did.
 */
async function measuredPolicy(siteAgentId: string, sdkOrigin: string) {
  try {
    const { preview } = await getSitePreview(siteAgentId);
    if (!preview || preview.rehearsalUnavailable) return undefined;
    if (!preview.violations) return undefined;
    return policyVerdictFromViolations({ violations: preview.violations, consoleOrigin: sdkOrigin });
  } catch {
    return undefined;
  }
}

/**
 * Reading the policy text: what the console can say when no browser has opened
 * the page. Marked `inferred`, and absent entirely when the site could not be
 * read at all — "we did not find a problem" and "we could not look" are
 * different answers.
 */
function inferredPolicy(input: {
  readiness: InstallReadiness;
  html: string;
  response: Response | undefined;
  sdkOrigin: string;
}): PolicyVerdict | { source: "unknown" } {
  const header = input.response?.headers.get("content-security-policy") || "";
  const reportOnly = !header && Boolean(input.response?.headers.get("content-security-policy-report-only"));
  const policyText = header || cspFromHtmlSafe(input.html);
  if (!input.response || (!policyText && !reportOnly)) {
    // No policy at all is a real answer only when the page was read.
    if (input.response) return { source: "inferred", findings: [], blocked: false, patches: [] };
    return { source: "unknown" };
  }
  if (!policyText) return { source: "inferred", findings: [], blocked: false, patches: [] };
  const parsed = parseCsp(policyText);
  const blockedKinds = ([
    ["script", "script-src"],
    ["api", "connect-src"],
    ["style", "style-src"],
    ["image", "img-src"],
  ] as const).filter(([, directive]) => !cspAllowsOrigin(parsed, directive, input.sdkOrigin));
  const findings = blockedKinds.map(([kind]) => ({ kind, blocked: true, disposition: "enforce" as const }));
  return {
    source: "inferred",
    findings,
    blocked: findings.length > 0,
    patches: findings.length
      ? [policyPatch({ policy: policyText, kinds: findings.map((finding) => finding.kind), origin: input.sdkOrigin, source: header ? "header" : "meta" })]
      : [],
  };
}

function cspFromHtmlSafe(html: string) {
  const match = /<meta[^>]+http-equiv=["\']?content-security-policy["\']?[^>]*>/i.exec(html || "");
  if (!match) return "";
  const content = /content=["\']([^"\']*)["\']/i.exec(match[0]);
  return content?.[1]?.trim() || "";
}

/**
 * What the last browser run proves about the address itself.
 *
 * A configured address is otherwise trusted on its shape: `https://` and not
 * local. That is enough to rule out mixed content, but not enough to know the
 * address answers — a stale domain or a typo in `.env` would be reported as
 * fine and hand out a snippet that can never load. The rehearsal puts the real
 * snippet in the page, so whether the SDK booted is the honest answer.
 */
async function rehearsalEvidence(siteAgentId: string) {
  try {
    const { preview } = await getSitePreview(siteAgentId);
    if (!preview || preview.rehearsalUnavailable) return undefined;
    return {
      ran: true,
      snippetPresent: Boolean(preview.agentDetected),
      connected: Boolean(preview.installConnected),
    };
  } catch {
    return undefined;
  }
}
