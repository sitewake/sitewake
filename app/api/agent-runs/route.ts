import { withRequestTiming } from "@/lib/http/request-timing";
import { NextRequest } from "next/server";
import { createAgentRun } from "../../../db/agent-run-store";
import type { AgentRun, JsonValue } from "../../../lib/site-knowledge/protocol";
import { controlPlaneOriginForRequest, siteAgentJson, siteAgentOptions, strictRunnerAuthorized } from "../site-agents/http";
import { agentRunError, runToken } from "./http";
import { boundedJsonErrorStatus, readBoundedJson } from "../../../lib/http/bounded-json";

export async function OPTIONS() { return siteAgentOptions(); }

async function handlePOST(request: NextRequest) {
  try {
    const body = await readBoundedJson<Record<string, unknown>>(request, 256_000);
    const siteAgentId = String(body.siteAgentId || "").trim();
    const origin = String(body.origin || "").trim();
    const url = String(body.url || "").trim();
    const goal = String(body.goal || "").trim().slice(0, 2_000);
    const documentId = String(body.documentId || "").trim();
    const browserSessionId = String(body.browserSessionId || "").trim();
    const controller = body.controller === "script" ? "script" as const : "page-agent" as const;
    const hasFollowupFields = Object.hasOwn(body, "sourceTaskId") || Object.hasOwn(body, "intent");
    const sourceTaskId = String(body.sourceTaskId || "").trim();
    const intent = body.intent === "reconciliation" || body.intent === "confirmed-continuation"
      ? body.intent
      : undefined;
    if (!siteAgentId || !origin || !url || !goal || (controller === "page-agent" && (!documentId || !browserSessionId))) throw new Error("agent_run_fields_required");
    if (hasFollowupFields && (!sourceTaskId || !intent)) throw new Error("agent_run_followup_fields_required");
    const sourceToken = hasFollowupFields ? runToken(request) : "";
    if (hasFollowupFields && !sourceToken) {
      return siteAgentJson({ error: "agent_run_followup_token_required" }, 401);
    }
    if (controller === "script" && !strictRunnerAuthorized(request)) {
      return siteAgentJson({ error: "unauthorized" }, 401);
    }
    const requestOrigin = request.headers.get("origin")?.trim() || undefined;
    const controlPlaneOrigin = controlPlaneOriginForRequest(request);
    const taskInput = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as Record<string, JsonValue> : {};
    const conversation = Array.isArray(body.conversation) ? body.conversation.slice(-30) as AgentRun["conversation"] : [];
    return siteAgentJson(await createAgentRun({
      siteAgentId, origin, url, goal, taskInput, conversation, documentId, browserSessionId,
      controller, requestOrigin, controlPlaneOrigin,
      followup: hasFollowupFields ? { sourceTaskId, intent: intent!, sourceToken } : undefined,
    }), 201);
  } catch (error) {
    const status = boundedJsonErrorStatus(error);
    if (status) return siteAgentJson({ error: status === 413 ? "request_body_too_large" : "invalid_json" }, status);
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("agent_run_followup_already_claimed")) {
      return siteAgentJson({ error: "agent_run_followup_already_claimed", message }, 409);
    }
    if (message.includes("agent_run_followup_source_not_terminal")
      || message.includes("agent_run_followup_source_not_uncertain")
      || message.includes("agent_run_followup_lineage_rejected")
      || message.includes("agent_run_followup_confirmation_rejected")) {
      return siteAgentJson({ error: message.split(":")[0], message }, 409);
    }
    return agentRunError(error);
  }
}

export const POST = withRequestTiming("run.create", handlePOST);
