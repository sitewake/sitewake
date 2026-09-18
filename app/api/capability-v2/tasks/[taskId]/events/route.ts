import { capabilityJson, capabilityOptions, capabilityReadAuthorized, siteIdFromRequest } from "../../../http";
import { getTask, sanitizeTaskForClient } from "@/db/capability-center-v2-store";
import { isTerminalTaskStatus } from "@/lib/capability-center-v2/model";

type Context = { params: Promise<{ taskId: string }> | { taskId: string } };
export async function OPTIONS() { return capabilityOptions(); }
export async function GET(request: Request, context: Context) {
  const siteId = siteIdFromRequest(request); const params = await context.params; const id = decodeURIComponent(params.taskId || "");
  if (!siteId || !id) return capabilityJson({ error: "site_id_and_task_id_required" }, 400);
  if (!(await capabilityReadAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  const initial = await getTask(siteId, id, true); if (!initial) return capabilityJson({ error: "task_not_found" }, 404);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastUpdatedAt = request.headers.get("last-event-id") || "";
      const deadline = Date.now() + 4 * 60_000;
      try {
        while (Date.now() < deadline && !request.signal.aborted) {
          const task = await getTask(siteId, id, true);
          if (!task) break;
          if (task.updatedAt !== lastUpdatedAt) {
            lastUpdatedAt = task.updatedAt;
            controller.enqueue(encoder.encode(`id: ${task.updatedAt}\nevent: task\ndata: ${JSON.stringify({ task: sanitizeTaskForClient(task) })}\n\n`));
          } else controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
          if (isTerminalTaskStatus(task.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      } finally { controller.close(); }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" } });
}
