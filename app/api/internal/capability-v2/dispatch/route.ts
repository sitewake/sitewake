import { RuntimeLauncher } from "@/runner/capability-v2/runtime-launcher";
import { capabilityJson, capabilityOptions, runnerAuthorized } from "@/app/api/capability-v2/http";

export async function OPTIONS() { return capabilityOptions(); }
export async function POST(request: Request) {
  if (!runnerAuthorized(request)) return capabilityJson({ error: "unauthorized" }, 401);
  let body: { siteId?: string; taskId?: string } = {};
  try { body = await request.json() as typeof body; } catch { return capabilityJson({ error: "invalid_json" }, 400); }
  try {
    const launcher = new RuntimeLauncher();
    const handle = body.siteId
      ? await launcher.dispatchOne(body.siteId, body.taskId)
      : await launcher.dispatchNext();
    return handle ? capabilityJson({ runnerId: handle.runnerId, runtimeType: handle.runtimeType, runtimeProvider: handle.runtimeProvider }, 202) : capabilityJson({ error: "pending_task_not_found" }, 404);
  }
  catch (error) { return capabilityJson({ error: "capability_v2_dispatch_failed", message: error instanceof Error ? error.message : "unknown" }, 500); }
}
