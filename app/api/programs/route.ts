import { putProgramModule } from "@/db/site-agent-store";
import { runnerAuthorized, siteAgentJson, siteAgentOptions } from "../site-agents/http";

export async function OPTIONS() { return siteAgentOptions(); }

export async function POST(request: Request) {
  if (!runnerAuthorized(request)) return siteAgentJson({ error: "runner_unauthorized" }, 401);
  try {
    const body = await request.json() as { siteAgentId?: string; source?: string };
    if (!body.siteAgentId?.trim() || !body.source?.trim()) return siteAgentJson({ error: "program_module_invalid" }, 400);
    return siteAgentJson({ module: await putProgramModule(body.siteAgentId.trim(), body.source) }, 201);
  } catch (error) {
    return siteAgentJson({ error: "program_module_save_failed", message: error instanceof Error ? error.message : "unknown" }, 400);
  }
}
