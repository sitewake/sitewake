import { siteAgentJson } from "../site-agents/http";

export function runToken(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
}

export function agentRunError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("not_found") ? 404
    : message.includes("revision_conflict") || message.includes("page_superseded") ? 409
      : message.includes("token") || message.includes("origin_rejected") || message.includes("browser_session_rejected") ? 403
        : message.includes("required") || message.includes("invalid") || message.includes("not_claimable") ? 400
          : 500;
  return siteAgentJson({ error: message.split(":")[0], message }, status);
}
