import { getImageBatch } from "@/lib/listing-workflow/image-batch-queue";
import { fail, handleRouteError, ok } from "@/lib/utils/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: { batchId: string } }) {
  try {
    const batch = await getImageBatch(context.params.batchId);
    if (!batch) return fail("IMAGE_BATCH_NOT_FOUND", "批量图片任务不存在", null, 404);
    return ok(batch);
  } catch (error) {
    return handleRouteError(error);
  }
}
