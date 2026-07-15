import { getRelayTask } from "@/lib/relay-mvp/store";
import { fail, ok } from "@/lib/utils/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: { taskId: string } }) {
  const task = getRelayTask(context.params.taskId);
  if (!task) return fail("TASK_NOT_FOUND", "测试任务不存在或已过期", null, 404);
  return ok(task);
}
