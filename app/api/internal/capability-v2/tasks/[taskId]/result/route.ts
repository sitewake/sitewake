import { PUT as handlePut } from "../[...path]/route";

export async function PUT(request: Request, context: { params: Promise<{ taskId: string }> | { taskId: string } }) {
  const params = await context.params;
  return handlePut(request, { params: { taskId: params.taskId, path: ["result"] } });
}
