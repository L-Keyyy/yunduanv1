import { NextRequest } from "next/server";
import { z } from "zod";

import { xiaohongshuPageSchema } from "@/lib/ai/schemas/xiaohongshu";
import { editXiaohongshuImage } from "@/lib/services/xiaohongshu-service";
import { handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  imageUrl: z.string().min(1),
  prompt: z.string().min(2),
  page: xiaohongshuPageSchema.optional().nullable(),
});

export async function POST(request: NextRequest) {
  try {
    const input = requestSchema.parse(await request.json());
    const image = await editXiaohongshuImage(input);
    return ok(image);
  } catch (error) {
    return handleRouteError(error);
  }
}
