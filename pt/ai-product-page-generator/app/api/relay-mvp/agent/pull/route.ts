import { claimRelayTask, isRelayAgentAuthorized } from "@/lib/relay-mvp/store";
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
  const id = String(body.agentId || "").trim().slice(0, 100);
  const mode = String(body.mode || "echo").trim().slice(0, 50);
  const version = String(body.version || "mvp").trim().slice(0, 50);
  if (!id) return fail("AGENT_ID_REQUIRED", "缺少 agentId", null, 400);
  return ok({ task: claimRelayTask({ id, mode, version }) });
}
