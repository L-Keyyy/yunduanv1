import { NextRequest } from "next/server";
import { z } from "zod";

import { planXiaohongshuPost } from "@/lib/services/xiaohongshu-service";
import { handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  topic: z.string().min(2),
  images: z.array(z.string().min(1)).max(4).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const input = requestSchema.parse(await request.json());
    const plan = await planXiaohongshuPost(input);
    return ok(plan);
  } catch (error) {
    return handleRouteError(error);
  }
}
