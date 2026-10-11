import { NextResponse } from "next/server";
import { configuredRunnerLeaseAuthority } from "@/db/runner-control-store";
import type { CompleteRunnerLeaseInput } from "@/lib/runner-control";

const RUNNER_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "cdn-cache-control": "no-store",
  "cloudflare-cdn-cache-control": "no-store",
};

export function runnerSessionToken(request: Request, body?: { sessionToken?: string }) {
  return body?.sessionToken || request.headers.get("x-sitewake-runner-session-token") || undefined;
}

function bearerToken(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
}

export function legacyRunnerProtocolEnabled() {
  return process.env.SITEWAKE_LEGACY_RUNNER_PROTOCOL === "true";
}

export function runnerEnrollmentAuthorized(request: Request) {
  const configured = process.env.SITEWAKE_RUNNER_ENROLLMENT_TOKEN?.trim();
  if (configured && bearerToken(request) === configured) return true;
  if (!legacyRunnerProtocolEnabled()) return false;
  const legacy = process.env.SITEWAKE_RUNNER_TOKEN?.trim();
  if (!legacy) return false;
  return bearerToken(request) === legacy || request.headers.get("x-sitewake-runner-token") === legacy;
}

export function runnerControlAuthorized(request: Request, body?: { sessionToken?: string }) {
  if (runnerSessionToken(request, body)) return true;
  if (!legacyRunnerProtocolEnabled()) return false;
  const legacy = process.env.SITEWAKE_RUNNER_TOKEN?.trim();
  if (!legacy) return false;
  return bearerToken(request) === legacy || request.headers.get("x-sitewake-runner-token") === legacy;
}

export function runnerLeaseControlInput(
  request: Request,
  runnerId: string,
): Omit<CompleteRunnerLeaseInput, "status" | "result"> | undefined {
  if (configuredRunnerLeaseAuthority() === "legacy") return undefined;
  const leaseId = request.headers.get("x-sitewake-control-lease-id");
  const token = request.headers.get("x-sitewake-lease-token");
  const fenceValue = request.headers.get("x-sitewake-control-lease-fence");
  if (!leaseId || !token || fenceValue === null) {
    if (legacyRunnerProtocolEnabled()) return undefined;
    throw new Error("runner_lease_control_required");
  }
  const fence = Number(fenceValue);
  if (!Number.isSafeInteger(fence) || fence < 1) throw new Error("runner_lease_fence_invalid");
  return {
    runnerId,
    runnerSessionId: request.headers.get("x-sitewake-runner-session-id") || undefined,
    sessionToken: runnerSessionToken(request),
    leaseId,
    token,
    fence,
  };
}

export function runnerJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { ...RUNNER_RESPONSE_HEADERS, ...headers },
  });
}

export function runnerControlErrorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // After a site is deleted, the runner's lease renewals and completion callbacks get
  // 404 — it retries only 408/429/5xx, so 404 terminates and never recreates the site.
  if (message === "site_agent_not_found" || (error as { code?: unknown } | null)?.code === "site_agent_not_found") return 404;
  if (message.startsWith("capability_run_patch_too_large")) return 413;
  if (/^capability_task_(?:completion_(?:conflict|fence_rejected)|browser_run_(?:conflict|mismatch|mode_mismatch)|lease_required)/.test(message)) return 409;
  if (/^(?:authored_candidate_missing|capability_task_(?:start_url_missing|materialization_missing|release_(?:missing|invalid|version_mismatch)))/.test(message)) return 400;
  if (/^(?:invalid_runner_lease|capability_run_(?:already_terminal|update_conflict)|capability_browser_run_conflict|runner_instance_not_found|runner_session_|runner_lease_(?:control_required|fence_|session_|token_|runner_|not_found|expired|completion_conflict|completion_busy))/.test(message)) {
    return 409;
  }
  if (/^(?:capability_run_(?:status_invalid|steps_invalid|artifacts_invalid|timings_invalid|nonterminal_result_rejected)|capability_browser_run_(?:invalid|required|requires_terminal_status|start_url_mismatch|result_url_untrusted|end_url_untrusted))/.test(message)) {
    return 400;
  }
  return 500;
}

/** Cheap, storage-free header validation performed before reading request data. */
export function runnerControlHeadersPlausible(
  request: Request,
  options: { requireLease?: boolean } = {},
) {
  const values = [
    request.headers.get("authorization"),
    request.headers.get("x-sitewake-runner-token"),
    request.headers.get("x-sitewake-runner-session-token"),
    request.headers.get("x-sitewake-runner-session-id"),
    request.headers.get("x-sitewake-control-lease-id"),
    request.headers.get("x-sitewake-control-lease-fence"),
    request.headers.get("x-sitewake-lease-token"),
  ].filter((value): value is string => value !== null);
  if (values.some((value) => value.length < 1 || value.length > 512)) return false;
  if (!runnerControlAuthorized(request)) return false;
  if (options.requireLease && !request.headers.get("x-sitewake-lease-token")) return false;
  return true;
}

// Runner control is server-to-server. Keep the legacy OPTIONS handlers for
// compatibility without advertising the endpoints to arbitrary web origins.
export function runnerOptions() {
  return new NextResponse(null, {
    status: 204,
    headers: RUNNER_RESPONSE_HEADERS,
  });
}
