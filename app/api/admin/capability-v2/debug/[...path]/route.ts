import {
  getCapabilityDebugTrace,
  listCapabilityDebugTraces,
  pruneCapabilityDebugData,
} from "@/db/capability-debug-store";
import type { DebugTraceKind, DebugTraceStatus } from "@/lib/capability-center-v2/debug-trace";
import {
  capabilityJson,
  capabilityOptions,
  capabilityReadAuthorized,
  errorResponse,
  siteIdFromRequest,
} from "@/app/api/capability-v2/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path: string[] }> | { path: string[] } };

async function segments(context: Context) {
  const params = await context.params;
  return (params.path || []).map((part) => decodeURIComponent(part));
}

function traceKind(value: string | undefined): DebugTraceKind | undefined {
  return value === "generation" || value === "usage" || value === "evolution" ? value : undefined;
}

function traceStatus(value: string | null): DebugTraceStatus | undefined {
  return value === "running" || value === "waiting" || value === "succeeded" || value === "handled" || value === "rejected" || value === "failed" || value === "cancelled" ? value : undefined;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function streamTrace(request: Request, siteId: string, kind: DebugTraceKind, id: string) {
  const initial = await getCapabilityDebugTrace(siteId, kind, id);
  if (!initial) return capabilityJson({ error: "debug_trace_not_found" }, 404);
  const encoder = new TextEncoder();
  const requestedCursor = request.headers.get("last-event-id") || new URL(request.url).searchParams.get("cursor") || "";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = requestedCursor;
      const deadline = Date.now() + 4 * 60_000;
      try {
        while (Date.now() < deadline && !request.signal.aborted) {
          const detail = await getCapabilityDebugTrace(siteId, kind, id);
          if (!detail) {
            controller.enqueue(encoder.encode(`event: deleted\ndata: ${JSON.stringify({ traceId: id })}\n\n`));
            break;
          }
          if (detail.cursor !== cursor) {
            cursor = detail.cursor;
            controller.enqueue(encoder.encode(`id: ${cursor}\nevent: trace\ndata: ${JSON.stringify(detail)}\n\n`));
          } else {
            controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
          }
          await sleep(1_000, request.signal);
        }
      } catch (error) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "debug_trace_stream_failed", message: error instanceof Error ? error.message : "unknown" })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export async function OPTIONS() {
  return capabilityOptions();
}

export async function GET(request: Request, context: Context) {
  if (!(await capabilityReadAuthorized(request))) return capabilityJson({ error: "unauthorized" }, 401);
  const siteId = siteIdFromRequest(request);
  if (!siteId) return capabilityJson({ error: "site_id_required" }, 400);
  const path = await segments(context);
  try {
    if (path[0] !== "traces") return capabilityJson({ error: "debug_route_not_found" }, 404);
    if (!path[1]) {
      const query = new URL(request.url).searchParams;
      const kind = traceKind(query.get("kind") || undefined);
      const group = query.get("group");
      if (query.has("kind") && !kind) return capabilityJson({ error: "debug_trace_kind_invalid" }, 400);
      if (group && group !== "generation" && group !== "usage") return capabilityJson({ error: "debug_trace_group_invalid" }, 400);
      void pruneCapabilityDebugData(siteId).catch((error) => console.warn("[capability-debug] retention failed", error));
      return capabilityJson(await listCapabilityDebugTraces(siteId, {
        kind,
        group: group === "generation" || group === "usage" ? group : undefined,
        status: traceStatus(query.get("status")),
        query: query.get("query") || undefined,
        cursor: query.get("cursor") || undefined,
        limit: Number(query.get("limit") || 40),
      }));
    }
    const kind = traceKind(path[1]);
    const id = path[2];
    if (!kind || !id) return capabilityJson({ error: "debug_trace_kind_and_id_required" }, 400);
    if (path[3] === "stream") return streamTrace(request, siteId, kind, id);
    const detail = await getCapabilityDebugTrace(siteId, kind, id);
    return detail ? capabilityJson(detail) : capabilityJson({ error: "debug_trace_not_found" }, 404);
  } catch (error) {
    return errorResponse(error, "capability_debug_get_failed");
  }
}
