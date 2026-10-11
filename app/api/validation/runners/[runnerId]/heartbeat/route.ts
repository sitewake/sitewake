import { heartbeatValidationRunner } from "@/db/site-agent-store";
import { runnerControlAuthorized, runnerJson, runnerOptions, runnerSessionToken } from "../../http";

type RouteContext = { params: Promise<{ runnerId: string }> | { runnerId: string } };
export async function OPTIONS() { return runnerOptions(); }
export async function POST(request: Request, context: RouteContext) {
  const { runnerId } = await context.params;
  const input = await request.json().catch(() => ({})) as {
    sessionId?: string;
    sessionToken?: string;
    status?: "online" | "offline" | "busy";
    activity?: { stage?: string; phase?: "preparing" | "observing" | "coding" | "testing" | "proposing" | "completed" | "failed"; message?: string; learningJobId?: string; artifactIds?: string[]; tokenUsage?: { input: number; output: number; cached?: number } } | null;
    lastError?: { code?: string; message: string; phase?: string };
    readySlots?: number;
  };
  if (!runnerControlAuthorized(request, input)) return runnerJson({ error: "runner_unauthorized" }, 401);
  try {
    return runnerJson(await heartbeatValidationRunner(
      decodeURIComponent(runnerId),
      input.status,
      input.activity,
      {
        sessionId: input.sessionId,
        sessionToken: runnerSessionToken(request, input),
        readySlots: input.readySlots,
        lastError: input.lastError,
        legacy: !runnerSessionToken(request, input),
      },
    ));
  }
  catch { return runnerJson({ error: "runner_heartbeat_failed", message: "Runner heartbeat failed." }, 500); }
}
