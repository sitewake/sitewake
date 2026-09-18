import { GET as handleGet } from "../[...path]/route";

export async function GET(request: Request, context: { params: Promise<{ taskId: string }> | { taskId: string } }) {
  const params = await context.params;
  return handleGet(request, { params: { taskId: params.taskId, path: ["run-spec"] } });
}
