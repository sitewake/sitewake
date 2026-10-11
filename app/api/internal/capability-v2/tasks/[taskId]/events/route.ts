import { POST as handlePost } from "../[...path]/route";

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> | { taskId: string } }) {
  const params = await context.params;
  return handlePost(request, { params: { taskId: params.taskId, path: ["events"] } });
}
