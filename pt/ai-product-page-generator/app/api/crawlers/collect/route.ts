import { NextRequest } from "next/server";
import { z } from "zod";

import { collectProductFromUrl } from "@/lib/crawlers/collect";
import { handleRouteError, ok } from "@/lib/utils/route";

export const runtime = "nodejs";

const collectSchema = z.object({
  url: z.string().trim().min(1, "请先粘贴商品链接"),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = collectSchema.parse(await request.json());
    const result = await collectProductFromUrl(parsed.url, request.signal);
    return ok(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
