import { createRelayTask, relayStatus } from "@/lib/relay-mvp/store";
import { fail, ok } from "@/lib/utils/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return ok(relayStatus());
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_JSON", "请求内容不是有效 JSON", null, 400);
  }
  const message =
    typeof body === "object" && body && "message" in body
      ? String((body as { message?: unknown }).message || "").trim()
      : "";
  if (!message) return fail("MESSAGE_REQUIRED", "请输入测试消息", null, 400);
  if (message.length > 4_000) return fail("MESSAGE_TOO_LONG", "测试消息不能超过 4000 字", null, 400);
  const status = relayStatus();
  if (status.counts.queued + status.counts.processing >= 20) {
    return fail("QUEUE_FULL", "测试队列已满，请稍后再试", null, 429);
  }
  return ok(createRelayTask(message), { status: 201 });
}
