import { NextRequest } from "next/server";
import { appendObservations } from "../../../../../db/site-agent-store";
import type { TransitionObservation } from "../../../../../lib/site-knowledge/protocol";
import { siteAgentFailure, siteAgentJson, siteAgentOptions } from "../../http";

type RouteContext = { params: Promise<{ siteAgentId: string }> | { siteAgentId: string } };
export async function OPTIONS() { return siteAgentOptions(); }
export async function POST(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const siteAgentId = decodeURIComponent(params.siteAgentId || "").trim();
  let observations: TransitionObservation[];
  try { const body = await request.json() as { observations?: TransitionObservation[] }; observations = body.observations || []; } catch { return siteAgentJson({ error: "invalid_json" }, 400); }
  if (!siteAgentId || !Array.isArray(observations) || observations.length > 100 || observations.some((item) => item.siteAgentId !== siteAgentId)) return siteAgentJson({ error: "invalid_observations" }, 400);
  try { return siteAgentJson(await appendObservations(siteAgentId, observations), 202); } catch (error) { return siteAgentFailure(error, "observation_ingest_failed"); }
}
