import { completeRelayTask, isRelayAgentAuthorized } from "@/lib/relay-mvp/store";
import { fail, ok } from "@/lib/utils/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!process.env.RELAY_MVP_AGENT_TOKEN?.trim()) {
    return fail("RELAY_NOT_CONFIGURED", "服务器尚未配置本机 Agent 密钥", null, 503);
  }
  if (!isRelayAgentAuthorized(request)) {
    return fail("UNAUTHORIZED", "Agent 密钥无效", null, 401);
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const taskId = String(body.taskId || "").trim();
  const agentId = String(body.agentId || "").trim();
  const status = body.status === "completed" ? "completed" : body.status === "failed" ? "failed" : null;
  if (!taskId || !agentId || !status) {
    return fail("INVALID_RESULT", "taskId、agentId 或 status 无效", null, 400);
  }
  const completed = completeRelayTask({
    taskId,
    agentId,
    status,
    response: typeof body.response === "string" ? body.response.slice(0, 100_000) : undefined,
    error: typeof body.error === "string" ? body.error.slice(0, 2_000) : undefined,
    processingMs: typeof body.processingMs === "number" ? Math.max(0, Math.round(body.processingMs)) : undefined,
  });
  if (completed === null) return fail("TASK_NOT_FOUND", "任务不存在或已过期", null, 404);
  if (completed === undefined) return fail("LEASE_MISMATCH", "任务不属于当前 Agent", null, 409);
  return ok(completed);
}
