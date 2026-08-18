import { z } from "zod";

import { controlImageBatch } from "@/lib/listing-workflow/image-batch-queue";
import { handleRouteError, ok } from "@/lib/utils/route";

const requestSchema = z.object({
  action: z.enum(["pause", "resume", "retry_failed", "cancel"]),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: { batchId: string } }) {
  try {
    const input = requestSchema.parse(await request.json());
    return ok(await controlImageBatch(context.params.batchId, input.action));
  } catch (error) {
    return handleRouteError(error);
  }
}
