import {
  GET as handleGet,
  POST as handlePost,
  PUT as handlePut,
} from "../tasks/[taskId]/[...path]/route";

type RouteContext = { taskId: string; action: string };

function routeContext(request: Request): RouteContext {
  const url = new URL(request.url);
  return { taskId: url.searchParams.get("taskId") || "", action: url.searchParams.get("action") || "" };
}

function contextOf(value: RouteContext) {
  return { params: { taskId: value.taskId, path: value.action.split("/").filter(Boolean) } };
}

export async function GET(request: Request) {
  return handleGet(request, contextOf(routeContext(request)));
}

export async function POST(request: Request) {
  return handlePost(request, contextOf(routeContext(request)));
}

export async function PUT(request: Request) {
  return handlePut(request, contextOf(routeContext(request)));
}
