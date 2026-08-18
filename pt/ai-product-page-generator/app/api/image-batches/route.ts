import { ImageQueueTaskType } from "@prisma/client";
import { z } from "zod";

import { createImageBatch, listImageBatches } from "@/lib/listing-workflow/image-batch-queue";
import { handleRouteError, ok } from "@/lib/utils/route";

const imageSchema = z.object({
  type: z.nativeEnum(ImageQueueTaskType).default(ImageQueueTaskType.GENERATE_MAIN),
  prompt: z.string().trim().min(4).max(5000).optional(),
  referenceImages: z.array(z.string().min(1)).max(4).optional().default([]),
  priority: z.number().int().min(-100).max(100).optional().default(0),
});

const productSchema = z.object({
  listingWorkflowItemId: z.string().min(1).optional(),
  offerId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(300),
  sourceUrl: z.string().min(1).optional(),
  sourceImageUrl: z.string().min(1).optional(),
  images: z.array(imageSchema).min(1).max(20).optional().default([
    { type: ImageQueueTaskType.GENERATE_MAIN, referenceImages: [], priority: 0 },
  ]),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120).default("批量图片任务"),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1),
  prompt: z.string().trim().min(4).max(5000),
  aspectRatio: z.enum(["1:1", "3:4", "9:16"]).default("1:1"),
  maxConcurrency: z.number().int().min(1).max(4).default(2),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  products: z.array(productSchema).min(1).max(500),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const take = Number(new URL(request.url).searchParams.get("take") || 30);
    return ok(await listImageBatches(Number.isFinite(take) ? take : 30));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = createSchema.parse(await request.json());
    const origin = new URL(request.url).origin;
    const batch = await createImageBatch({ ...input, requestOrigin: origin });
    return ok(batch, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
