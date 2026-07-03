import { NextRequest } from "next/server";
import { z } from "zod";

import { xiaohongshuPlanSchema } from "@/lib/ai/schemas/xiaohongshu";
import { generateXiaohongshuImages } from "@/lib/services/xiaohongshu-service";
import { handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  plan: xiaohongshuPlanSchema,
  referenceImages: z.array(z.string().min(1)).max(4).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const input = requestSchema.parse(await request.json());
    const images = await generateXiaohongshuImages(input.plan, input.referenceImages ?? []);
    return ok(images);
  } catch (error) {
    return handleRouteError(error);
  }
}
